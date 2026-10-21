# Current mode: signatures optional

Role signature enforcement defaults to `disabled`. Users may be created through the frontend or directly in SQL without `ROLE_SIGNATURE`; no migration is required. Password and active-account checks still apply. Database role changes are read on authenticated requests. Restart the backend after deploying these changes.

Set `ROLE_SIGNATURE_ENFORCEMENT=disabled` to explicitly disable signature checks, including when a saved security configuration exists. `compat` allows unsigned accounts but validates existing signatures; `strict` requires valid signatures. The environment setting takes precedence over the saved mode.

The setup procedure below is optional and enables strict mode only when no environment override is set.

# One-command user security setup

Deploy the updated code, pause users, then run this on the backend server:

```powershell
node scripts/setupUserSecurity.js
```

The script creates missing user-table columns, generates and privately stores the signing key, saves a baseline snapshot of existing accounts, hashes plaintext passwords without changing usable passwords, signs accounts, verifies active accounts, then enables strict protection. This command treats every account currently in USER as the trusted initial baseline. Normal login remains compatible until verification passes. After success, users sign in again with the same passwords. No manual environment editing or second activation command is required.

The running updated backend reads `.role-security.json` dynamically, so protection activates when the script finishes. Preserve this private file across deployments and back it up securely; it contains the signing key. It is excluded from Git. Run the command on the same backend installation that serves the app. If using multiple backend servers, deploy the same protected configuration to every instance before allowing traffic; this one-host script does not distribute secrets remotely.

If the command stops, fix its reported issue and rerun the same command. Completed migrations are preserved, valid signed accounts are skipped, and new strict enforcement is not enabled on failure. Do not delete the key or change existing signing environment keys. A leftover `.local/user-security-setup.lock` after a crashed process must be removed only after confirming no setup process is still running.

Back up the database before the maintenance window. Table preparation may briefly take a schema lock, and account hashing duration varies; five minutes is an estimate. Legacy plaintext passwords exceeding 72 UTF-8 bytes require a separate password migration and are skipped. Any changed/invalid accounts stop activation. Do not run an older plaintext-only backend after migration.

Unsigned users and changed signed roles/credentials are rejected once setup completes. A database-only administrator cannot generate signatures without the server-side key, but can delete/restore rows or deny service. Restoring an earlier valid signed state requires an external trusted version store to detect. Previously exposed plaintext passwords should be reset separately.

The underlying `migrateSignedUsers.js --prepare|--snapshot|--apply|--check` commands remain available for controlled troubleshooting. For normal setup, use only the command above. Scripts have been prepared, not executed against production accounts.
