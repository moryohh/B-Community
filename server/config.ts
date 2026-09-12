import dotenv from 'dotenv';
dotenv.config();

// =========================================================================
// UNIFIED SERVER-SIDE CONFIGURATION & SECRETS MANAGER (NO HARDCODED VALUES)
// =========================================================================

export const SERVER_CONFIG = {
  // SUPABASE B: Community DB (Posts, Comments, Admins, Reports)
  COMMUNITY_SUPABASE_URL: (process.env.COMMUNITY_SUPABASE_URL || process.env.SUPABASE_URL || '').trim(),
  COMMUNITY_SUPABASE_SERVICE_ROLE_KEY: (process.env.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COMMUNITY_SERVICE_ROLE_KEY || '').trim(),

  // SUPABASE A: Educational & Auth DB (JWT validation for Site 1 students/admins)
  AUTH_SUPABASE_A_URL: (process.env.AUTH_SUPABASE_A_URL || process.env.AUTH_SUPABASE_URL || process.env.SUPABASE_A_URL || '').trim(),
  AUTH_SUPABASE_A_ANON_KEY: (process.env.AUTH_SUPABASE_A_ANON_KEY || process.env.AUTH_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim(),

  // CORS Origins for Site 1
  COMMUNITY_ALLOWED_ORIGINS: (process.env.COMMUNITY_ALLOWED_ORIGINS || 'https://moryohh.github.io,https://a-1q1.pages.dev,http://localhost:3000,http://localhost:5173')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),

  // Community Admin Security
  COMMUNITY_ADMIN_EMAILS: (process.env.COMMUNITY_ADMIN_EMAILS || 'qqwwee1111qqqq@gmail.com,admin@platform.edu')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean),
  COMMUNITY_ADMIN_USER_IDS: (process.env.COMMUNITY_ADMIN_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  ADMIN_RECOVERY_SECRET_KEY: (process.env.ADMIN_RECOVERY_SECRET_KEY || process.env.COMMUNITY_ADMIN_SECRET || '').trim(),

  // OCR Engines & AI Models (Server-side execution only)
  OCR_API_KEY_1: (process.env.OCR_API_KEY_1 || '').trim(),
  OCR_API_KEY_2: (process.env.OCR_API_KEY_2 || '').trim(),
  OCR_API_KEY_3: (process.env.OCR_API_KEY_3 || '').trim(),
  OCR_API_KEY: (process.env.OCR_API_KEY || '').trim(),
  DEEPSEEK_API_KEY: (process.env.DEEPSEEK_API_KEY || '').trim(),

  // Apify Scraper Tokens
  APIFY_TOKEN_1: (process.env.APIFY_TOKEN_1 || '').trim(),
  APIFY_TOKEN_2: (process.env.APIFY_TOKEN_2 || '').trim(),
  APIFY_TOKEN_3: (process.env.APIFY_TOKEN_3 || '').trim(),
  APIFY_TOKEN_4: (process.env.APIFY_TOKEN_4 || '').trim(),
};

// Check for database isolation
export function checkDatabaseIsolation(): { isIsolated: boolean; warning?: string } {
  const urlA = SERVER_CONFIG.AUTH_SUPABASE_A_URL.toLowerCase();
  const urlB = SERVER_CONFIG.COMMUNITY_SUPABASE_URL.toLowerCase();

  if (urlA && urlB && urlA === urlB) {
    const warning = '[SECURITY WARNING] Auth Supabase A and Community Supabase B share the same project URL. Complete physical database isolation requires distinct project instances.';
    return { isIsolated: false, warning };
  }
  return { isIsolated: true };
}

// Log status without revealing secrets
export function logSystemSecurityStatus() {
  const isolation = checkDatabaseIsolation();
  if (isolation.warning) {
    console.warn(isolation.warning);
  }
  console.log('[SECURITY STATUS] Loaded Secrets:', {
    hasCommunityDbUrl: Boolean(SERVER_CONFIG.COMMUNITY_SUPABASE_URL),
    hasCommunityServiceRole: Boolean(SERVER_CONFIG.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY),
    hasAuthAUrl: Boolean(SERVER_CONFIG.AUTH_SUPABASE_A_URL),
    hasAuthAAnonKey: Boolean(SERVER_CONFIG.AUTH_SUPABASE_A_ANON_KEY),
    hasOcrApiKey: Boolean(SERVER_CONFIG.OCR_API_KEY_1 || SERVER_CONFIG.OCR_API_KEY_2 || SERVER_CONFIG.OCR_API_KEY_3 || SERVER_CONFIG.OCR_API_KEY),
    configuredOcrBases: [SERVER_CONFIG.OCR_API_KEY_1, SERVER_CONFIG.OCR_API_KEY_2, SERVER_CONFIG.OCR_API_KEY_3].filter(Boolean).length,
    hasDeepseekApiKey: Boolean(SERVER_CONFIG.DEEPSEEK_API_KEY),
    allowedOriginsCount: SERVER_CONFIG.COMMUNITY_ALLOWED_ORIGINS.length,
  });
}
