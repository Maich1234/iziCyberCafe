SET search_path=izicybercafe,pg_catalog;
CREATE TABLE maintenance_jobs(name TEXT PRIMARY KEY,lease_token TEXT NOT NULL,lease_until BIGINT NOT NULL,last_started BIGINT NOT NULL,last_finished BIGINT,status TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}');
ALTER TABLE maintenance_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_access ON maintenance_jobs TO izicyber_runtime USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON maintenance_jobs TO izicyber_runtime;
