import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { pinAuthHandler } from "./handler.mjs";
const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
};
Deno.serve(
  pinAuthHandler({
    createClient,
    url: required("SUPABASE_URL"),
    publishableKey: required("SUPABASE_ANON_KEY"),
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    appOrigin: new URL(
      Deno.env.get("MATERIAL_APP_ORIGIN") ||
        "https://polite-conkies-1226e4.netlify.app",
    ).origin,
  }),
);
