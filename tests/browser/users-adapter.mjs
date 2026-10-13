// Local simulation of GoTrue delivery/confirmation; NO email or real Auth accounts.
import { pool, IDS } from "../db-helper.mjs";
import { userManagementHandler } from "../../supabase/functions/user-management/handler.mjs";
export function claims(header) {
  const token = (header || "").replace("Bearer ", "");
  if (token.startsWith("token-")) {
    const role = token.slice(6);
    return {
      sub: IDS[role],
      session_id: IDS["session" + role[0]?.toUpperCase() + role.slice(1)],
    };
  }
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}
export function accessToken(id, session) {
  return (
    "e30." +
    Buffer.from(
      JSON.stringify({
        sub: id,
        session_id: session,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url") +
    "." +
    Buffer.from("fake-signature").toString("base64url")
  );
}
export async function authUser(id) {
  const u = (
    await pool.query("select id,email from auth.users where id=$1", [id])
  ).rows[0];
  return u
    ? {
        ...u,
        aud: "authenticated",
        role: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      }
    : null;
}
export async function runUser(header, sql, args = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      header === "Bearer local-service"
        ? "set local role service_role"
        : "set local role authenticated",
    );
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(claims(header)),
    ]);
    const r = await c.query(sql, args);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const definitions = {
  material_manage_users: [
    "select public.material_manage_users($1,$2) as result",
    ["action", "target"],
  ],
  material_prepare_invite: [
    "select public.material_prepare_invite($1,$2) as result",
    ["email_input", "request"],
  ],
  material_finish_invite: [
    "select public.material_finish_invite($1,$2,$3,$4,$5,$6) as result",
    [
      "invitation",
      "request",
      "actor",
      "actor_session",
      "new_user",
      "delivered",
    ],
  ],
};
export const handler = userManagementHandler({
  url: "http://127.0.0.1:8040",
  publishableKey: "public",
  serviceKey: "local-service",
  appOrigin: "http://127.0.0.1:8000",
  createClient: (url, key, options) => ({
    auth: {
      getUser: async (token) => ({
        data: { user: await authUser(claims("Bearer " + token).sub) },
      }),
      admin: {
        inviteUserByEmail: async (email, opts) => {
          let u = (
            await pool.query("select * from auth.users where email=$1", [email])
          ).rows[0];
          if (u?.email_confirmed_at) return { error: true };
          if (!u)
            u = (
              await pool.query(
                "insert into auth.users(id,email,invited_at,raw_user_meta_data)values($1,$2,now(),$3)returning *",
                [crypto.randomUUID(), email, JSON.stringify(opts.data)],
              )
            ).rows[0];
          return { data: { user: { id: u.id } } };
        },
      },
      resetPasswordForEmail: async () => ({ data: {} }),
    },
    rpc: async (name, args) => {
      try {
        const [sql, keys] = definitions[name];
        return {
          data: (
            await runUser(
              key === "local-service"
                ? "Bearer local-service"
                : options.global.headers.Authorization,
              sql,
              keys.map((k) => args[k] ?? null),
            )
          )[0].result,
        };
      } catch (error) {
        return { error };
      }
    },
  }),
});
export async function confirmation(email) {
  const inv = (
    await pool.query(
      "select * from material_private.invitations where email=$1",
      [email],
    )
  ).rows[0];
  if (!inv?.user_id) throw new Error("No local invitation");
  await pool.query(
    "update auth.users set email_confirmed_at=now() where id=$1",
    [inv.user_id],
  );
  const session = crypto.randomUUID();
  await pool.query("insert into auth.sessions(id,user_id)values($1,$2)", [
    session,
    inv.user_id,
  ]);
  return {
    url: `http://127.0.0.1:8000/?invitation=${inv.id}#access_token=${accessToken(inv.user_id, session)}&refresh_token=refresh-invited&type=invite`,
    user: inv.user_id,
  };
}
