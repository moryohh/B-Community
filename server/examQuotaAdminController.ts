import { Response } from 'express';
import { AuthenticatedRequest, getAdminAClient } from './communityAuth';

function dbOr503(res: Response) {
  const db = getAdminAClient();
  if (!db) res.status(503).json({ error: 'أضف AUTH_SUPABASE_A_SERVICE_ROLE_KEY إلى إعدادات الخادم لتفعيل إدارة الامتحانات.' });
  return db;
}

export async function getExamQuotaDashboard(req: AuthenticatedRequest, res: Response) {
  const db = dbOr503(res); if (!db) return;
  const query = String(req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 30;
  const [{ data: settings, error: settingsError }, usersResult] = await Promise.all([
    db.from('exam_quota_settings').select('*').eq('id', 1).single(),
    db.auth.admin.listUsers({ page, perPage }),
  ]);
  if (settingsError || usersResult.error) return res.status(500).json({ error: settingsError?.message || usersResult.error?.message });
  const authUsers: any[] = (usersResult.data?.users || []) as any[];
  const users = authUsers.filter((user: any) => {
    if (!query) return true;
    const name = String(user.user_metadata?.full_name || user.user_metadata?.name || '').toLowerCase();
    return user.id.toLowerCase().includes(query) || String(user.email || '').toLowerCase().includes(query) || name.includes(query);
  });
  const ids = users.map((user) => user.id);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone || 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [{ data: entitlements }, { data: attempts }] = await Promise.all([
    ids.length ? db.from('account_exam_entitlements').select('*').in('user_id', ids) : Promise.resolve({ data: [] as any[] }),
    ids.length ? db.from('exam_attempts').select('user_id,exam_kind').in('user_id', ids).eq('usage_date', date) : Promise.resolve({ data: [] as any[] }),
  ]);
  const entitlementMap = new Map((entitlements || []).map((row: any) => [row.user_id, row]));
  const usage = new Map<string, { daily: number; shared: number }>();
  for (const row of attempts || []) {
    const current = usage.get(row.user_id) || { daily: 0, shared: 0 };
    if (row.exam_kind === 'daily') current.daily += 1; else current.shared += 1;
    usage.set(row.user_id, current);
  }
  return res.json({ settings, date, page, users: users.map((user) => ({
    id: user.id, email: user.email, name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0],
    entitlement: entitlementMap.get(user.id) || null, usage: usage.get(user.id) || { daily: 0, shared: 0 },
  })) });
}

export async function updateExamQuotaSettings(req: AuthenticatedRequest, res: Response) {
  const db = dbOr503(res); if (!db) return;
  const daily = Number(req.body.daily_limit);
  const shared = Number(req.body.monthly_ministry_shared_limit);
  if (!Number.isInteger(daily) || daily < 0 || !Number.isInteger(shared) || shared < 0) return res.status(400).json({ error: 'يجب أن تكون الحدود أرقاماً صحيحة موجبة أو صفراً.' });
  const { data, error } = await db.from('exam_quota_settings').update({ daily_limit: daily, monthly_ministry_shared_limit: shared, updated_at: new Date().toISOString() }).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await db.from('exam_quota_audit_log').insert({ admin_user_id: req.user?.id, action: 'update_global_limits', details: { daily_limit: daily, monthly_ministry_shared_limit: shared } });
  return res.json({ settings: data });
}

export async function updateAccountExamEntitlement(req: AuthenticatedRequest, res: Response) {
  const db = dbOr503(res); if (!db) return;
  const userId = String(req.params.userId || '');
  const body = req.body || {};
  const row = {
    user_id: userId,
    plan: ['free','premium','custom'].includes(body.plan) ? body.plan : 'free',
    status: ['active','exam_blocked','blocked'].includes(body.status) ? body.status : 'active',
    unlimited_exams: Boolean(body.unlimited_exams),
    daily_limit_override: body.daily_limit_override === null || body.daily_limit_override === '' ? null : Math.max(0, Number(body.daily_limit_override) || 0),
    monthly_ministry_limit_override: body.monthly_ministry_limit_override === null || body.monthly_ministry_limit_override === '' ? null : Math.max(0, Number(body.monthly_ministry_limit_override) || 0),
    valid_until: body.valid_until || null,
    notes: String(body.notes || '').slice(0, 1000) || null,
    updated_at: new Date().toISOString(), updated_by: req.user?.id,
  };
  const { data, error } = await db.from('account_exam_entitlements').upsert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await db.from('exam_quota_audit_log').insert({ admin_user_id: req.user?.id, target_user_id: userId, action: 'update_account_entitlement', details: row });
  return res.json({ entitlement: data });
}
