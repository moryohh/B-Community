import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save, Search, ShieldBan, UserCog } from 'lucide-react';
import { getStoredAuthToken } from '../api';

type UserRow = { id: string; email?: string; name?: string; usage: { daily: number; shared: number }; entitlement: any };

async function adminRequest(path: string, options?: RequestInit) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getStoredAuthToken()}`, ...(options?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'فشل تنفيذ الطلب');
  return body;
}

export function ExamQuotaManagement() {
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setMessage('');
    try { setData(await adminRequest(`/api/v1/community/admin/exam-quotas?search=${encodeURIComponent(search)}`)); }
    catch (error: any) { setMessage(error.message); }
    finally { setLoading(false); }
  }, [search]);
  useEffect(() => { void load(); }, []);

  const saveSettings = async () => {
    try {
      const result = await adminRequest('/api/v1/community/admin/exam-quotas/settings', { method: 'PATCH', body: JSON.stringify(data.settings) });
      setData((current: any) => ({ ...current, settings: result.settings })); setMessage('تم تطبيق الحدود العامة فوراً على موقع A.');
    } catch (error: any) { setMessage(error.message); }
  };
  const saveUser = async (user: UserRow) => {
    try {
      const entitlement = user.entitlement || { plan: 'free', status: 'active', unlimited_exams: false, daily_limit_override: null, monthly_ministry_limit_override: null };
      const result = await adminRequest(`/api/v1/community/admin/exam-quotas/accounts/${user.id}`, { method: 'PATCH', body: JSON.stringify(entitlement) });
      setData((current: any) => ({ ...current, users: current.users.map((row: UserRow) => row.id === user.id ? { ...row, entitlement: result.entitlement } : row) }));
      setMessage(`تم تحديث حساب ${user.email || user.name}.`);
    } catch (error: any) { setMessage(error.message); }
  };
  const editUser = (id: string, field: string, value: any) => setData((current: any) => ({ ...current, users: current.users.map((row: UserRow) => row.id === id ? { ...row, entitlement: { plan: 'free', status: 'active', unlimited_exams: false, daily_limit_override: null, monthly_ministry_limit_override: null, ...(row.entitlement || {}), [field]: value } } : row) }));

  if (!data) return <div className="rounded-2xl border bg-white p-8 text-center"><RefreshCw className={`mx-auto mb-3 ${loading ? 'animate-spin' : ''}`} />{message || 'جارٍ تحميل إدارة الامتحانات...'}</div>;
  return <div className="space-y-5" dir="rtl">
    <section className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2"><UserCog className="text-indigo-600"/><h2 className="font-black">الحدود العامة لامتحانات موقع A</h2></div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm font-bold">الامتحان اليومي يومياً<input type="number" min="0" value={data.settings.daily_limit} onChange={e => setData({ ...data, settings: { ...data.settings, daily_limit: Number(e.target.value) } })} className="mt-2 w-full rounded-xl border p-3"/></label>
        <label className="text-sm font-bold">الشهري + الوزاري (مشترك)<input type="number" min="0" value={data.settings.monthly_ministry_shared_limit} onChange={e => setData({ ...data, settings: { ...data.settings, monthly_ministry_shared_limit: Number(e.target.value) } })} className="mt-2 w-full rounded-xl border p-3"/></label>
        <button onClick={saveSettings} className="mt-auto flex items-center justify-center gap-2 rounded-xl bg-indigo-600 p-3 font-black text-white"><Save size={18}/>حفظ وتطبيق فوراً</button>
      </div><p className="mt-3 text-xs text-slate-500">إعادة الضبط عند منتصف الليل بتوقيت {data.settings.timezone}. الشهري والوزاري يستخدمان الرصيد نفسه.</p>
    </section>
    <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute right-3 top-3 text-slate-400" size={18}/><input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()} placeholder="ابحث بالبريد أو الاسم أو رقم الحساب" className="w-full rounded-xl border py-3 pl-3 pr-10"/></div><button onClick={load} className="rounded-xl bg-slate-900 px-5 font-bold text-white">بحث</button></div>
    {message && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">{message}</div>}
    <div className="space-y-3">{data.users.map((user: UserRow) => { const ent = user.entitlement || {}; return <article key={user.id} className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><div className="font-black">{user.name || 'مستخدم'}</div><div className="text-xs text-slate-500">{user.email} · {user.id}</div></div><div className="flex gap-2 text-xs font-bold"><span className="rounded-lg bg-sky-50 px-2 py-1 text-sky-700">اليومي {user.usage.daily}/{ent.unlimited_exams ? '∞' : ent.daily_limit_override ?? data.settings.daily_limit}</span><span className="rounded-lg bg-violet-50 px-2 py-1 text-violet-700">شهري+وزاري {user.usage.shared}/{ent.unlimited_exams ? '∞' : ent.monthly_ministry_limit_override ?? data.settings.monthly_ministry_shared_limit}</span></div></div>
      <div className="grid gap-2 md:grid-cols-6">
        <select value={ent.plan || 'free'} onChange={e=>editUser(user.id,'plan',e.target.value)} className="rounded-lg border p-2"><option value="free">مجاني</option><option value="premium">مدفوع</option><option value="custom">مخصص</option></select>
        <select value={ent.status || 'active'} onChange={e=>editUser(user.id,'status',e.target.value)} className="rounded-lg border p-2"><option value="active">نشط</option><option value="exam_blocked">حظر الامتحانات</option><option value="blocked">حظر كامل</option></select>
        <input type="number" min="0" value={ent.daily_limit_override ?? ''} onChange={e=>editUser(user.id,'daily_limit_override',e.target.value)} placeholder="حد يومي خاص" className="rounded-lg border p-2"/>
        <input type="number" min="0" value={ent.monthly_ministry_limit_override ?? ''} onChange={e=>editUser(user.id,'monthly_ministry_limit_override',e.target.value)} placeholder="حد مشترك خاص" className="rounded-lg border p-2"/>
        <label className="flex items-center gap-2 rounded-lg border p-2 text-sm font-bold"><input type="checkbox" checked={Boolean(ent.unlimited_exams)} onChange={e=>editUser(user.id,'unlimited_exams',e.target.checked)}/>غير محدود</label>
        <button onClick={()=>saveUser(user)} className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 p-2 font-bold text-white"><Save size={16}/>حفظ</button>
      </div>
    </article>; })}</div>
    {!data.users.length && <div className="rounded-xl border bg-white p-8 text-center text-slate-500"><ShieldBan className="mx-auto mb-2"/>لا توجد حسابات مطابقة.</div>}
  </div>;
}
