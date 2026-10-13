import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { userManagementHandler } from "./handler.mjs";
const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
};
// Public project configuration, never a credential. A server secret can override
// the origin when this repository is installed for another department/site.
const origin = new URL(
  Deno.env.get("MATERIAL_APP_ORIGIN") ||
    "https://polite-conkies-1226e4.netlify.app",
).origin;
Deno.serve(
  userManagementHandler({
    createClient,
    url: required("SUPABASE_URL"),
    publishableKey: required("SUPABASE_ANON_KEY"),
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    appOrigin: origin,
  }),
);
