-- Run before deploying multi-level access. Existing users keep ACCESS_LEVEL.
IF COL_LENGTH('dbo.USER', 'ACCESS_LEVELS') IS NULL
  ALTER TABLE dbo.[USER] ADD ACCESS_LEVELS VARCHAR(50) NULL;
GO
