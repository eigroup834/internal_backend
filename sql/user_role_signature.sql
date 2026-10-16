-- Apply during the planned signed-role cutover, before starting the updated backend.
IF COL_LENGTH('dbo.USER', 'ROLE_SIGNATURE') IS NULL
  ALTER TABLE dbo.[USER] ADD ROLE_SIGNATURE VARCHAR(64) NULL;
GO
