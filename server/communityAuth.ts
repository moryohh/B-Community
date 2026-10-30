import { Request, Response, NextFunction } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SERVER_CONFIG } from './config';

// =========================================================================
// ISOLATED SUPABASE CLIENTS CONFIGURATION (NO HARDCODED SECRETS)
// =========================================================================

// Supabase B: Community DB
const COMMUNITY_URL = SERVER_CONFIG.COMMUNITY_SUPABASE_URL;
const COMMUNITY_SERVICE_ROLE_KEY = SERVER_CONFIG.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY;

// Supabase A: Educational & Auth DB (JWT validation only)
const AUTH_SUPABASE_A_URL = SERVER_CONFIG.AUTH_SUPABASE_A_URL;
const AUTH_SUPABASE_A_ANON_KEY = SERVER_CONFIG.AUTH_SUPABASE_A_ANON_KEY;

let communitySupabaseClient: SupabaseClient | null = null;
let authSupabaseAClient: SupabaseClient | null = null;
let adminSupabaseAClient: SupabaseClient | null = null;

/**
 * Get dedicated Supabase B client for Community operations (Server-side only)
 */
export function getCommunityDbClient(): SupabaseClient | null {
  if (!communitySupabaseClient && COMMUNITY_URL && COMMUNITY_SERVICE_ROLE_KEY) {
    communitySupabaseClient = createClient(COMMUNITY_URL, COMMUNITY_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return communitySupabaseClient;
}

/**
 * Get Supabase A client for verifying student & admin JWTs
 * Strictly requires Supabase A Anon/Public Key - NEVER uses Supabase B Service Role Key
 */
export function getAuthAClient(): SupabaseClient | null {
  if (!authSupabaseAClient && AUTH_SUPABASE_A_URL && AUTH_SUPABASE_A_ANON_KEY) {
    authSupabaseAClient = createClient(AUTH_SUPABASE_A_URL, AUTH_SUPABASE_A_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authSupabaseAClient;
}

export function getAdminAClient(): SupabaseClient | null {
  const key = SERVER_CONFIG.AUTH_SUPABASE_A_SERVICE_ROLE_KEY;
  if (!adminSupabaseAClient && AUTH_SUPABASE_A_URL && key) {
    adminSupabaseAClient = createClient(AUTH_SUPABASE_A_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminSupabaseAClient;
}

// Master Admin Emails & Recovery Key
export const MASTER_OWNER_EMAILS = SERVER_CONFIG.COMMUNITY_ADMIN_EMAILS;
export const MASTER_OWNER_EMAIL = MASTER_OWNER_EMAILS[0] || 'qqwwee1111qqqq@gmail.com';
export const RECOVERY_SECRET_KEY = SERVER_CONFIG.ADMIN_RECOVERY_SECRET_KEY;

// =========================================================================
// TYPES & IN-MEMORY CACHE FOR DASHBOARD ADMINS (3 SEATS CAP)
// =========================================================================
export interface DashboardAdminRecord {
  id: string;
  user_id: string;
  display_name: string;
  email?: string;
  role: 'owner' | 'admin';
  status: 'active' | 'revoked';
  created_by: string;
  created_at: string;
  updated_at: string;
  revoked_at?: string | null;
  last_login_at?: string;
}

// Initial Primary Owner record in memory
export const inMemoryDashboardAdmins: DashboardAdminRecord[] = [
  {
    id: 'adm_owner_primary',
    user_id: 'usr_owner_root',
    display_name: 'مالك المنظومة (Primary Owner)',
    email: MASTER_OWNER_EMAIL,
    role: 'owner',
    status: 'active',
    created_by: 'system_bootstrap',
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    updated_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  }
];

export interface AuthenticatedUser {
  id: string;
  email?: string;
  role?: string;
  displayName?: string;
  avatarUrl?: string;
  adminRole?: 'owner' | 'admin';
  rawUser?: any;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  isAdmin?: boolean;
  adminRecord?: DashboardAdminRecord;
}

// =========================================================================
// MIDDLEWARE: JWT AUTHENTICATION (Verifies token against Supabase A)
// =========================================================================
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'غير مصرح: يرجى تسجيل الدخول وإرفاق رمز التحقق (Bearer Token)',
        code: 'UNAUTHORIZED'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token || token.trim().length === 0) {
      return res.status(401).json({
        error: 'رمز التحقق غير صالح أو فارغ',
        code: 'INVALID_TOKEN'
      });
    }

    const authA = getAuthAClient();
    if (!authA) {
      return res.status(503).json({
        error: 'خدمة التحقق من الهوية (Supabase A) غير مهيأة أو غير متصلة',
        code: 'AUTH_SERVICE_UNAVAILABLE'
      });
    }

    const { data: { user }, error } = await authA.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        error: 'رمز التحقق منتهي الصلاحية أو غير صالح في منصة التعليم (Supabase A)',
        code: 'TOKEN_EXPIRED'
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'طالب المنصة',
      avatarUrl: user.user_metadata?.avatar_url || null,
      rawUser: user,
    };

    next();
  } catch (err: any) {
    return res.status(401).json({
      error: `فشل التحقق من هوية المستخدم: ${err.message}`,
      code: 'AUTH_FAILED'
    });
  }
}

export async function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const authA = getAuthAClient();
      if (authA && token) {
        const { data: { user } } = await authA.auth.getUser(token);
        if (user) {
          req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.user_metadata?.full_name || user.user_metadata?.name || 'طالب المنصة',
            avatarUrl: user.user_metadata?.avatar_url || null,
          };
        }
      }
    }
  } catch (_) {}
  next();
}

// =========================================================================
// MIDDLEWARE: STRICT 3-ADMINS ENFORCEMENT & AUTHORIZATION
// =========================================================================
export async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL || !!process.env.K_SERVICE;
    const db = getCommunityDbClient();

    // 1. Authenticate JWT from Supabase A
    const authHeader = req.headers.authorization;
    let verifiedUserId: string | null = null;
    let verifiedEmail: string | null = null;
    let verifiedDisplayName: string | null = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const authA = getAuthAClient();
      if (!authA) {
        return res.status(503).json({
          error: 'خدمة التحقق من الهوية (Supabase A) غير مهيأة أو غير متصلة',
          code: 'AUTH_SERVICE_UNAVAILABLE'
        });
      }
      if (token) {
        const { data: { user }, error } = await authA.auth.getUser(token);
        if (error || !user) {
          return res.status(401).json({
            error: 'رمز التحقق منتهي الصلاحية أو غير صالح في منصة التعليم (Supabase A)',
            code: 'TOKEN_EXPIRED'
          });
        }
        verifiedUserId = user.id;
        verifiedEmail = (user.email || '').toLowerCase().trim();
        verifiedDisplayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'مشرف المنظومة';
      }
    }

    if (!verifiedUserId) {
      return res.status(401).json({
        error: 'غير مصرح: يجب تسجيل الدخول برمز JWT صالح لحساب إداري نشط من Supabase A',
        code: 'UNAUTHORIZED_ADMIN'
      });
    }

    // 2. Verify Active Status in `dashboard_admins` (Strict database query)
    if (!db && isProd) {
      return res.status(503).json({
        error: 'قاعدة بيانات المجتمع (Supabase B) غير متصلة',
        code: 'DATABASE_UNAVAILABLE'
      });
    }

    let adminRecord: DashboardAdminRecord | null = null;

    if (db) {
      const { data, error } = await db
        .from('dashboard_admins')
        .select('*')
        .eq('user_id', verifiedUserId)
        .eq('status', 'active')
        .maybeSingle();

      if (error && isProd) {
        return res.status(503).json({
          error: `تعذر التحقق من صلاحية الحساب الإداري في قاعدة البيانات: ${error.message}`,
          code: 'DATABASE_UNAVAILABLE'
        });
      }

      if (data) {
        adminRecord = data;
      }
    }

    // Fallback to memory table ONLY in local dev mode
    if (!adminRecord && !isProd) {
      adminRecord = inMemoryDashboardAdmins.find(a => 
        (a.user_id === verifiedUserId || (verifiedEmail && a.email && a.email.toLowerCase() === verifiedEmail)) && 
        a.status === 'active'
      ) || null;
    }

    // Automatic Owner Provisioning for Root Master Email if authenticated via Supabase A
    if (!adminRecord && verifiedEmail && MASTER_OWNER_EMAILS.includes(verifiedEmail)) {
      const ownerRec: DashboardAdminRecord = {
        id: `adm_${Date.now()}_root`,
        user_id: verifiedUserId,
        display_name: verifiedDisplayName || 'مالك المنظومة',
        email: verifiedEmail,
        role: 'owner',
        status: 'active',
        created_by: 'system_root_bootstrap',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      };
      if (db) {
        const { error: upsertErr } = await db.from('dashboard_admins').upsert(ownerRec, { onConflict: 'user_id' });
        if (upsertErr && isProd) {
          return res.status(503).json({
            error: `تعذر تهيئة حساب المالك في قاعدة البيانات: ${upsertErr.message}`,
            code: 'DATABASE_UNAVAILABLE'
          });
        }
        adminRecord = ownerRec;
      } else if (!isProd) {
        inMemoryDashboardAdmins.unshift(ownerRec);
        adminRecord = ownerRec;
      }
    }

    if (!adminRecord || adminRecord.status !== 'active') {
      return res.status(403).json({
        error: 'غير مصرح: حسابك ليس ضمن قائمة الحسابات الإدارية الثلاثة النشطة (Dashboard Admins)',
        code: 'FORBIDDEN_NOT_ACTIVE_ADMIN'
      });
    }

    // Update last login timestamp asynchronously
    adminRecord.last_login_at = new Date().toISOString();
    if (db) {
      db.from('dashboard_admins').update({ last_login_at: new Date().toISOString() }).eq('id', adminRecord.id).then();
    }

    req.isAdmin = true;
    req.adminRecord = adminRecord;
    req.user = {
      id: adminRecord.user_id,
      email: adminRecord.email || verifiedEmail || undefined,
      displayName: adminRecord.display_name,
      adminRole: adminRecord.role,
    };

    next();
  } catch (err: any) {
    return res.status(403).json({
      error: `فشل التحقق من صلاحيات الإدارة: ${err.message}`,
      code: 'ADMIN_AUTH_FAILED'
    });
  }
}

/**
 * Expose client-safe public config for Supabase A Anon Key (Auth only, no secrets)
 */
export function getPublicAuthAConfig() {
  return {
    supabaseAUrl: AUTH_SUPABASE_A_URL || '',
    supabaseAAnonKey: AUTH_SUPABASE_A_ANON_KEY || '',
  };
}

