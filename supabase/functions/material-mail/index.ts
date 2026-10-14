import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { materialMailHandler } from "./handler.mjs";
Deno.serve(
  materialMailHandler({
    server: createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ),
    jobToken: Deno.env.get("MATERIAL_MAIL_JOB_TOKEN") || "",
    resendKey: Deno.env.get("RESEND_API_KEY") || "",
    from: Deno.env.get("MATERIAL_MAIL_FROM") || "",
    appOrigin: "https://polite-conkies-1226e4.netlify.app/",
  }),
);
