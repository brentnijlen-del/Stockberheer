import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { userManagementHandler } from "./handler.mjs";
const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
};
const origin = new URL(required("MATERIAL_APP_ORIGIN")).origin;
Deno.serve(
  userManagementHandler({
    createClient,
    url: required("SUPABASE_URL"),
    publishableKey: required("SUPABASE_ANON_KEY"),
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    appOrigin: origin,
  }),
);
