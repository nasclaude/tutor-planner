// The owner's "People" screen: accounts, invitations, password resets and removal.
import { HttpError, json, readJson } from './util.js';
import { requireAdmin, createInvite, hashPassword, newTemporaryPassword, normalizeInviteCode } from './auth.js';

export async function listPeople(env, admin) {
  requireAdmin(admin);
  const now = Date.now();
  const [users, invites] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, username, is_admin, must_change_password, created_at FROM users ORDER BY created_at'),
    env.DB.prepare('SELECT code, note, created_at, expires_at FROM invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').bind(now),
  ]);
  return json({
    users: users.results.map((u) => ({ ...u, is_admin: !!u.is_admin, must_change_password: !!u.must_change_password })),
    invites: invites.results,
  });
}

export async function addInvite(request, env, admin) {
  requireAdmin(admin);
  const { note } = await readJson(request);
  return json(await createInvite(env, admin, note), 201);
}

export async function cancelInvite(env, admin, code) {
  requireAdmin(admin);
  await env.DB.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').bind(normalizeInviteCode(code)).run();
  return json({ ok: true });
}

async function otherUser(env, admin, id) {
  requireAdmin(admin);
  if (id === admin.id) throw new HttpError(400, 'Use Settings to change your own account', 'not_on_yourself');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!user) throw new HttpError(404, 'Not found', 'not_found');
  return user;
}

// A forgotten password: the owner gets a temporary one to pass on. The person's devices are logged out
// and the app asks them to choose a new password after logging in.
export async function resetPassword(env, admin, id) {
  const user = await otherUser(env, admin, id);
  const tempPassword = newTemporaryPassword();
  await env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(env, tempPassword), Date.now(), user.id)
    .run();
  return json({ tempPassword });
}

// Removes the account and everything in it (also how a request to delete someone's data is handled).
export async function removeUser(env, admin, id) {
  const user = await otherUser(env, admin, id);
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM reminder_log WHERE item_id IN (SELECT id FROM lessons WHERE user_id = ? UNION SELECT id FROM events WHERE user_id = ?)').bind(user.id, user.id),
    ...['homework', 'grades', 'lessons', 'events', 'students', 'push_subscriptions', 'user_settings'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id),
    ),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true });
}
