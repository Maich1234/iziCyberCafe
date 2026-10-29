-- Server-only role. Enable LOGIN and set a generated password securely at provisioning.
CREATE ROLE izicyber_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA izicybercafe TO izicyber_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA izicybercafe TO izicyber_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA izicybercafe TO izicyber_runtime;
DO $$
DECLARE app_table record;
BEGIN
  FOR app_table IN SELECT tablename FROM pg_tables WHERE schemaname='izicybercafe' LOOP
    EXECUTE format('CREATE POLICY server_access ON izicybercafe.%I TO izicyber_runtime USING (true) WITH CHECK (true)', app_table.tablename);
  END LOOP;
END;
$$;
