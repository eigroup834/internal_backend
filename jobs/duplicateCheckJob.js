const cron = require("node-cron");
const nodemailer = require("nodemailer");
const { poolPromise } = require("../db");
const { TABLES } = require("../helper");

function parseJsonField(val) {
  if (!val) return [];
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractEmails(emailJson) {
  return parseJsonField(emailJson)
    .map((e) => (typeof e === "string" ? e : e?.email || e?.value || ""))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function extractPhones(phoneJson) {
  return parseJsonField(phoneJson)
    .map((p) => {
      if (typeof p === "string") return p.replace(/\s+/g, "");
      const isd = (p.isd || "").toString().replace(/\D/g, "");
      const num = (p.number || "").toString().replace(/\D/g, "");
      return isd ? `+${isd}${num}` : num;
    })
    .filter(Boolean);
}

async function findDuplicates() {
  const pool = await poolPromise;

  // ── Companies ──
  const companyRows = await pool.request().query(`
    SELECT COMPANY_CODE, COMPANY_NAME, EMAIL, PHONES, WEBSITE
    FROM dbo.[${TABLES.COMPANY_DETAIL}]
  `);

  const emailToCompanies = {};
  const phoneToCompanies = {};

  for (const row of companyRows.recordset) {
    const ref = { code: row.COMPANY_CODE, name: row.COMPANY_NAME || "" };
    for (const email of extractEmails(row.EMAIL)) {
      (emailToCompanies[email] = emailToCompanies[email] || []).push(ref);
    }
    for (const phone of extractPhones(row.PHONES)) {
      (phoneToCompanies[phone] = phoneToCompanies[phone] || []).push(ref);
    }
  }

  // Website duplicates via SQL (simpler, no JSON)
  const websiteRows = await pool.request().query(`
    SELECT WEBSITE, COUNT(*) AS cnt,
      STRING_AGG(COMPANY_CODE + ' — ' + ISNULL(COMPANY_NAME, ''), ', ') AS companies
    FROM dbo.[${TABLES.COMPANY_DETAIL}]
    WHERE WEBSITE IS NOT NULL AND LTRIM(RTRIM(WEBSITE)) != ''
    GROUP BY WEBSITE
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  // ── Persons ──
  const personRows = await pool.request().query(`
    SELECT PERSON_CODE, FNAME, LNAME, COMPANY_CODE, PERSON_EMAIL, MOBILE
    FROM dbo.[${TABLES.COMP_PERSON}]
  `);

  const emailToPersons = {};
  const phoneToPersons = {};

  for (const row of personRows.recordset) {
    const name = `${row.FNAME || ""} ${row.LNAME || ""}`.trim();
    const ref = { code: row.PERSON_CODE, name, company: row.COMPANY_CODE || "" };
    for (const email of extractEmails(row.PERSON_EMAIL)) {
      (emailToPersons[email] = emailToPersons[email] || []).push(ref);
    }
    for (const phone of extractPhones(row.MOBILE)) {
      (phoneToPersons[phone] = phoneToPersons[phone] || []).push(ref);
    }
  }

  return {
    companyEmail: Object.entries(emailToCompanies)
      .filter(([, a]) => a.length > 1)
      .map(([value, records]) => ({ value, records })),

    companyPhone: Object.entries(phoneToCompanies)
      .filter(([, a]) => a.length > 1)
      .map(([value, records]) => ({ value, records })),

    companyWebsite: websiteRows.recordset.map((r) => ({
      value: r.WEBSITE,
      count: r.cnt,
      companies: r.companies,
    })),

    personEmail: Object.entries(emailToPersons)
      .filter(([, a]) => a.length > 1)
      .map(([value, records]) => ({ value, records })),

    personPhone: Object.entries(phoneToPersons)
      .filter(([, a]) => a.length > 1)
      .map(([value, records]) => ({ value, records })),
  };
}

function buildHtmlReport(results, date) {
  const total =
    results.companyEmail.length +
    results.companyPhone.length +
    results.companyWebsite.length +
    results.personEmail.length +
    results.personPhone.length;

  if (total === 0) return null;

  const th = `style="background:#1e3a5f;color:#fff;padding:8px 12px;text-align:left;border:1px solid #ccc;"`;
  const td = `style="padding:7px 12px;border:1px solid #ddd;vertical-align:top;font-size:13px;"`;
  const tbl = `style="border-collapse:collapse;width:100%;margin-bottom:28px;"`;

  function section(icon, title, color, rows, headRow, bodyRow) {
    if (!rows.length) return "";
    return `
      <h3 style="color:${color};margin:24px 0 6px;font-size:15px;">${icon} ${title} &nbsp;<span style="font-size:12px;color:#666;">(${rows.length} group${rows.length > 1 ? "s" : ""})</span></h3>
      <table ${tbl}><thead>${headRow()}</thead><tbody>
        ${rows.map((r, i) => bodyRow(r, i)).join("")}
      </tbody></table>`;
  }

  const companyEmailHtml = section(
    "📧", "Duplicate Company Emails", "#c0392b",
    results.companyEmail,
    () => `<tr><th ${th}>Email</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td>
      <td ${td}>${r.records.map((c) => `<b>${c.code}</b> — ${c.name}`).join("<br>")}</td>
    </tr>`
  );

  const companyPhoneHtml = section(
    "📞", "Duplicate Company Phones", "#e67e22",
    results.companyPhone,
    () => `<tr><th ${th}>Phone</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td>
      <td ${td}>${r.records.map((c) => `<b>${c.code}</b> — ${c.name}`).join("<br>")}</td>
    </tr>`
  );

  const companyWebsiteHtml = section(
    "🌐", "Duplicate Company Websites", "#8e44ad",
    results.companyWebsite,
    () => `<tr><th ${th}>Website</th><th ${th}>Count</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td>
      <td ${td}>${r.count}</td>
      <td ${td}>${r.companies}</td>
    </tr>`
  );

  const personEmailHtml = section(
    "👤", "Duplicate Person Emails", "#c0392b",
    results.personEmail,
    () => `<tr><th ${th}>Email</th><th ${th}>Persons</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td>
      <td ${td}>${r.records.map((p) => `<b>${p.code}</b> — ${p.name} (${p.company})`).join("<br>")}</td>
    </tr>`
  );

  const personPhoneHtml = section(
    "📱", "Duplicate Person Phones", "#e67e22",
    results.personPhone,
    () => `<tr><th ${th}>Phone</th><th ${th}>Persons</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td>
      <td ${td}>${r.records.map((p) => `<b>${p.code}</b> — ${p.name} (${p.company})`).join("<br>")}</td>
    </tr>`
  );

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#333;padding:20px;max-width:960px;margin:auto;">
    <div style="background:#1e3a5f;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:18px;">EI Portal — Duplicate Records Report</h2>
      <p style="margin:4px 0 0;font-size:12px;opacity:0.75;">${date}</p>
    </div>
    <div style="background:#fff3cd;border:1px solid #ffc107;padding:10px 20px;">
      <strong>Total duplicate groups found: ${total}</strong>
    </div>
    <div style="padding:8px 0;">
      ${companyEmailHtml}
      ${companyPhoneHtml}
      ${companyWebsiteHtml}
      ${personEmailHtml}
      ${personPhoneHtml}
    </div>
    <p style="font-size:11px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px;">
      Automated daily report — EI Internal Portal
    </p>
  </body></html>`;
}

async function runDuplicateCheck() {
  console.log("[DuplicateCheck] Running...");
  try {
    const results = await findDuplicates();
    const dateStr = new Date().toLocaleDateString("en-IN", { dateStyle: "full" });
    const html = buildHtmlReport(results, dateStr);

    if (!html) {
      console.log("[DuplicateCheck] No duplicates found. No email sent.");
      return;
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const totalCompany =
      results.companyEmail.length +
      results.companyPhone.length +
      results.companyWebsite.length;
    const totalPerson =
      results.personEmail.length + results.personPhone.length;

    await transporter.sendMail({
      from: `"EI Portal" <${process.env.SMTP_USER}>`,
      to: process.env.REPORT_EMAIL,
      subject: `[EI Portal] Duplicate Report — ${totalCompany} company, ${totalPerson} person groups — ${dateStr}`,
      html,
    });

    console.log("[DuplicateCheck] Email sent to", process.env.REPORT_EMAIL);
  } catch (err) {
    console.error("[DuplicateCheck] Error:", err.message);
  }
}

const schedule = process.env.DUPLICATE_CHECK_CRON || "0 18 * * *";
cron.schedule(schedule, runDuplicateCheck, { timezone: "Asia/Kolkata" });
console.log(`[DuplicateCheck] Scheduled at cron "${schedule}" (Asia/Kolkata)`);

module.exports = { runDuplicateCheck };
