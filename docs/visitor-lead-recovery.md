# Recover skipped visitor registrations

Run from the backend directory:

    node jobs/visitorRegSyncJob.js --recover-missing

This reads the visitor API from since_id=0 without resetting or updating the normal sync cursor. It inserts only contacts without an existing source reference or matching email/mobile. Existing lead rows are never updated in recovery mode, including worked, assigned, invalid and converted leads. Activity logs are untouched. Phone does not participate in duplicate matching. Repeating recovery skips previously inserted records.

Do not reset VISITOR_SYNC_STATE or run a normal full replay to recover skipped contacts: the normal importer refreshes existing details and categories. Recovery does not repair contact details overwritten by the previous phone-matching bug; those need a separate review.
