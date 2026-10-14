// Disposable simulation: passwords are fictitious SHA-256 digests, not real GoTrue bcrypt.
import { createHash } from "node:crypto";
import { pool } from "../db-helper.mjs";
import { authUser, claims, accessToken, runUser } from "./users-adapter.mjs";
import { pinAuthHandler } from "../../supabase/functions/pin-auth/handler.mjs";
export const passwordDigest = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function pinSession(user) {
  const id = crypto.randomUUID();
  await pool.query("insert into auth.sessions(id,user_id)values($1,$2)", [
    id,
    user,
  ]);
  const u = await authUser(user);
  return {
    access_token: accessToken(user, id),
    refresh_token: `refresh-pin:${user}:${id}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: u,
  };
}
export const pinDefinitions = {
  material_pin_prepare_enrol: [
    "select public.material_pin_prepare_enrol($1,$2,$3,$4) as result",
    ["actor", "actor_session", "invitation", "request"],
  ],
  material_pin_finish_enrol: [
    "select public.material_pin_finish_enrol($1,$2,$3,$4,$5) as result",
    ["actor", "actor_session", "invitation", "request", "succeeded"],
  ],
  material_pin_prepare_login: [
    "select public.material_pin_prepare_login($1) as result",
    ["email_input"],
  ],
  material_pin_finish_login: [
    "select public.material_pin_finish_login($1,$2) as result",
    ["actor", "actor_session"],
  ],
  material_pin_prepare_reset: [
    "select public.material_pin_prepare_reset($1) as result",
    ["email_input"],
  ],
};
export const handler = pinAuthHandler({
  url: "http://127.0.0.1:8040",
  publishableKey: "public",
  serviceKey: "local-service",
  appOrigin: "http://127.0.0.1:8000",
  createClient: (url, key) => ({
    auth: {
      getUser: async (token) => ({
        data: { user: await authUser(claims("Bearer " + token).sub) },
      }),
      admin: {
        updateUserById: async (user, { password }) => {
          const r = await pool.query(
            "update auth.users set encrypted_password=$1 where id=$2 returning id",
            [passwordDigest(password), user],
          );
          // Exercise the stricter case where a password change revokes the
          // caller's old session; the broker must return a fresh session.
          if (r.rowCount)
            await pool.query("delete from auth.sessions where user_id=$1", [
              user,
            ]);
          return r.rowCount
            ? { data: { user: await authUser(user) } }
            : { error: true };
        },
      },
      signInWithPassword: async ({ email, password }) => {
        const u = (
          await pool.query("select * from auth.users where lower(email)=$1", [
            email,
          ])
        ).rows[0];
        if (!u || u.encrypted_password !== passwordDigest(password))
          return { error: true };
        const session = await pinSession(u.id);
        return { data: { user: session.user, session } };
      },
      resetPasswordForEmail: async () => ({ data: {} }),
    },
    rpc: async (name, args) => {
      try {
        const [sql, keys] = pinDefinitions[name];
        const r = await runUser(
          key === "local-service" ? "Bearer local-service" : null,
          sql,
          keys.map((k) => args[k] ?? null),
        );
        return { data: r[0].result };
      } catch (error) {
        return { error };
      }
    },
  }),
});
export async function recovery(email) {
  const u = (
    await pool.query("select id from auth.users where lower(email)=$1", [email])
  ).rows[0];
  if (!u) throw new Error("No fictitious recovery account");
  const session = await pinSession(u.id);
  return {
    url: `http://127.0.0.1:8000/?pin_reset=1#access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=recovery`,
  };
}
