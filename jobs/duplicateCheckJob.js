const cron = require("node-cron");
const nodemailer = require("nodemailer");
const { getPool, withRetry } = require("../db");
const { TABLES } = require("../helper");

async function findDuplicates() {
  const pool = await getPool();

  const run = (query) => withRetry(() => pool.request().query(query));

  const companyEmailRows = await run(`
    SELECT
      LOWER(TRIM(email)) AS value,
      COUNT(*)           AS cnt,
      STRING_AGG(c.COMPANY_CODE + N' — ' + ISNULL(c.COMPANY_NAME, N''), N', ') AS companies
    FROM dbo.[${TABLES.COMPANY_DETAIL}] c WITH (NOLOCK)
    CROSS APPLY OPENJSON(c.EMAIL) j
    CROSS APPLY (SELECT
      COALESCE(
        JSON_VALUE(j.value, '$.email'),
        JSON_VALUE(j.value, '$.value'),
        CASE WHEN ISJSON(j.value) = 0 THEN j.value END
      ) AS email
    ) x
    WHERE c.EMAIL IS NOT NULL
      AND LEN(c.EMAIL) > 2
      AND x.email IS NOT NULL
      AND LEN(TRIM(x.email)) > 0
    GROUP BY LOWER(TRIM(x.email))
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  // ── Company: duplicate phones ────────────────────────────────────────────
  const companyPhoneRows = await run(`
    SELECT
      phone              AS value,
      COUNT(*)           AS cnt,
      STRING_AGG(c.COMPANY_CODE + N' — ' + ISNULL(c.COMPANY_NAME, N''), N', ') AS companies
    FROM dbo.[${TABLES.COMPANY_DETAIL}] c WITH (NOLOCK)
    CROSS APPLY OPENJSON(c.PHONES) j
    CROSS APPLY (SELECT
      CASE
        WHEN ISJSON(j.value) = 0 THEN j.value
        WHEN JSON_VALUE(j.value, '$.isd') IS NOT NULL
          THEN N'+' + JSON_VALUE(j.value, '$.isd') + JSON_VALUE(j.value, '$.number')
        ELSE JSON_VALUE(j.value, '$.number')
      END AS phone
    ) x
    WHERE c.PHONES IS NOT NULL
      AND LEN(c.PHONES) > 2
      AND x.phone IS NOT NULL
      AND LEN(TRIM(x.phone)) > 0
    GROUP BY x.phone
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  // ── Company: duplicate websites ──────────────────────────────────────────
  const companyWebsiteRows = await run(`
    SELECT
      WEBSITE           AS value,
      COUNT(*)          AS cnt,
      STRING_AGG(COMPANY_CODE + N' — ' + ISNULL(COMPANY_NAME, N''), N', ') AS companies
    FROM dbo.[${TABLES.COMPANY_DETAIL}] WITH (NOLOCK)
    WHERE WEBSITE IS NOT NULL AND LTRIM(RTRIM(WEBSITE)) != N''
    GROUP BY WEBSITE
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  // ── Person: duplicate emails ─────────────────────────────────────────────
  const personEmailRows = await run(`
    SELECT
      LOWER(TRIM(x.email)) AS value,
      COUNT(*)              AS cnt,
      STRING_AGG(
        p.PERSON_CODE + N' — ' + ISNULL(p.FNAME, N'') + N' ' + ISNULL(p.LNAME, N'') +
        N' (' + ISNULL(p.COMPANY_CODE, N'') + N')', N', '
      ) AS persons
    FROM dbo.[${TABLES.COMP_PERSON}] p WITH (NOLOCK)
    CROSS APPLY OPENJSON(p.PERSON_EMAIL) j
    CROSS APPLY (SELECT
      COALESCE(
        JSON_VALUE(j.value, '$.email'),
        JSON_VALUE(j.value, '$.value'),
        CASE WHEN ISJSON(j.value) = 0 THEN j.value END
      ) AS email
    ) x
    WHERE p.PERSON_EMAIL IS NOT NULL
      AND LEN(p.PERSON_EMAIL) > 2
      AND x.email IS NOT NULL
      AND LEN(TRIM(x.email)) > 0
    GROUP BY LOWER(TRIM(x.email))
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  // ── Person: duplicate phones ─────────────────────────────────────────────
  const personPhoneRows = await run(`
    SELECT
      x.phone            AS value,
      COUNT(*)           AS cnt,
      STRING_AGG(
        p.PERSON_CODE + N' — ' + ISNULL(p.FNAME, N'') + N' ' + ISNULL(p.LNAME, N'') +
        N' (' + ISNULL(p.COMPANY_CODE, N'') + N')', N', '
      ) AS persons
    FROM dbo.[${TABLES.COMP_PERSON}] p WITH (NOLOCK)
    CROSS APPLY OPENJSON(p.MOBILE) j
    CROSS APPLY (SELECT
      CASE
        WHEN ISJSON(j.value) = 0 THEN j.value
        WHEN JSON_VALUE(j.value, '$.isd') IS NOT NULL
          THEN N'+' + JSON_VALUE(j.value, '$.isd') + JSON_VALUE(j.value, '$.number')
        ELSE JSON_VALUE(j.value, '$.number')
      END AS phone
    ) x
    WHERE p.MOBILE IS NOT NULL
      AND LEN(p.MOBILE) > 2
      AND x.phone IS NOT NULL
      AND LEN(TRIM(x.phone)) > 0
    GROUP BY x.phone
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  return {
    companyEmail:   companyEmailRows.recordset,
    companyPhone:   companyPhoneRows.recordset,
    companyWebsite: companyWebsiteRows.recordset,
    personEmail:    personEmailRows.recordset,
    personPhone:    personPhoneRows.recordset,
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
    "", "Duplicate Company Emails", "#c0392b",
    results.companyEmail,
    () => `<tr><th ${th}>Email</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td><td ${td}>${r.companies}</td>
    </tr>`
  );

  const companyPhoneHtml = section(
    "", "Duplicate Company Phones", "#e67e22",
    results.companyPhone,
    () => `<tr><th ${th}>Phone</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td><td ${td}>${r.companies}</td>
    </tr>`
  );

  const companyWebsiteHtml = section(
    "", "Duplicate Company Websites", "#8e44ad",
    results.companyWebsite,
    () => `<tr><th ${th}>Website</th><th ${th}>Count</th><th ${th}>Companies</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td><td ${td}>${r.cnt}</td><td ${td}>${r.companies}</td>
    </tr>`
  );

  const personEmailHtml = section(
    "", "Duplicate Person Emails", "#c0392b",
    results.personEmail,
    () => `<tr><th ${th}>Email</th><th ${th}>Persons</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td><td ${td}>${r.persons}</td>
    </tr>`
  );

  const personPhoneHtml = section(
    "", "Duplicate Person Phones", "#e67e22",
    results.personPhone,
    () => `<tr><th ${th}>Phone</th><th ${th}>Persons</th></tr>`,
    (r, i) => `<tr style="${i % 2 ? "background:#f7f9fc;" : ""}">
      <td ${td}>${r.value}</td><td ${td}>${r.persons}</td>
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
