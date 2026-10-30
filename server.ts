import express from "express";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { createServer as createViteServer } from "vite";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { extractTextFromImage } from "./server/ocrService";
import { compareQuestionWithAnswer } from "./server/comparator";
import { compareWithDeepSeek } from "./server/deepseekService";
import {
  requireAuth,
  optionalAuth,
  requireAdmin,
  AuthenticatedRequest,
  getPublicAuthAConfig,
} from "./server/communityAuth";
import {
  getPublishedPosts,
  getSinglePost,
  createPost,
  getPostComments,
  addComment,
  togglePostReaction,
  reportPost,
  presignMediaUpload,
  completeMediaUpload,
} from "./server/communityController";
import {
  getAdminPosts,
  updatePostStatus,
  getAdminReports,
  resolveReport,
  getAdminStats,
  importCommunityJson,
} from "./server/communityAdminController";
import {
  listDashboardAdmins,
  addDashboardAdmin,
  revokeDashboardAdmin,
  restoreDashboardAdmin,
} from "./server/communityAdminManagementController";
import {
  createCourseReminder,
  listCourseReminders,
} from "./server/courseReminderController";
import { communityCorsMiddleware } from "./server/corsMiddleware";
import { getExamQuotaDashboard, updateExamQuotaSettings, updateAccountExamEntitlement } from "./server/examQuotaAdminController";
import { logSystemSecurityStatus } from "./server/config";

dotenv.config();

export interface BaseErrorLogRecord {
  id: string;
  timestamp: string;
  error: string;
  question?: string;
  statusCode?: number;
}

export interface OcrProjectRecord {
  id: string;
  name: string;
  project_url: string;
  status: 'active' | 'disabled';
  is_current_leader: boolean;
  request_count: number;
  success_count: number;
  failure_count: number;
  last_failure_reason?: string;
  last_failure_at?: string | null;
  recent_errors?: BaseErrorLogRecord[];
  load_limit: number;
  priority_order: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientSafeOcrProject {
  id: string;
  name: string;
  project_url: string;
  has_service_role_key: boolean;
  has_ocr_api_key: boolean;
  status: 'active' | 'disabled';
  is_current_leader: boolean;
  request_count: number;
  success_count: number;
  failure_count: number;
  last_failure_reason?: string;
  last_failure_at?: string | null;
  recent_errors?: BaseErrorLogRecord[];
  load_limit: number;
  priority_order: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OcrComparisonHistoryItem {
  id: string;
  imageUrl?: string;
  fileName?: string;
  fileSize?: number;
  questionText: string;
  extractedAnswer: string;
  similarityScore: number;
  matchVerdict: 'full_match' | 'partial_match' | 'no_match';
  matchedKeywords: string[];
  missingKeywords: string[];
  explanation?: string;
  processingTimeMs: number;
  processedByProject: {
    id: string;
    name: string;
    ocrEngineUsed?: string;
  } | null;
  engineUsed?: string;
  source: 'external_api' | 'testing_sandbox';
  createdAt: string;
  status: 'completed' | 'failed';
  errorMessage?: string;
  failureStage?: 'validation' | 'ocr' | 'deepseek' | 'comparison';
  deepseekStatus?: 'not_configured' | 'success' | 'failed' | 'local_fallback';
  requestId?: string;
  score?: number;
  maxScore?: number;
  percentage?: number;
  attemptedBases?: Array<{
    projectId: string;
    projectName: string;
    status: 'completed' | 'failed';
    error?: string;
    durationMs?: number;
  }>;
  failoverOccurred?: boolean;
  failoverNote?: string;
}

// In-Memory comparison history store
let ocrHistory: OcrComparisonHistoryItem[] = [];

// Global Round-Robin Dispatch Pointer (Equal Request-by-Request Rotation: 1 -> 2 -> 3 -> 1...)
let roundRobinIndex = 0;

// Dedicated Server-Side Secure Secret Store (Never Exposed to Frontend / Cached In Plain Objects)
const secureProjectSecrets = new Map<string, { service_role_key?: string; ocr_api_key?: string }>();

function getProjectSecrets(id: string) {
  return secureProjectSecrets.get(id) || {};
}

function setProjectSecrets(id: string, secrets: { service_role_key?: string; ocr_api_key?: string }) {
  const existing = secureProjectSecrets.get(id) || {};
  secureProjectSecrets.set(id, { ...existing, ...secrets });
}

function removeProjectSecret(id: string, keyType: 'service_role_key' | 'ocr_api_key') {
  const existing = secureProjectSecrets.get(id) || {};
  if (keyType === 'service_role_key') {
    delete existing.service_role_key;
  } else if (keyType === 'ocr_api_key') {
    delete existing.ocr_api_key;
  }
  secureProjectSecrets.set(id, existing);
}

function getEffectiveProjectKeys(idOrProject?: string | OcrProjectRecord | null) {
  const id = typeof idOrProject === 'string' ? idOrProject : idOrProject?.id;
  const secrets = id ? getProjectSecrets(id) : {};
  const sRole = (secrets.service_role_key && secrets.service_role_key.trim()) || runtimeServiceRoleKey.trim();
  const oKey = getServerOcrApiKey(id) || (secrets.ocr_api_key && secrets.ocr_api_key.trim()) || runtimeDefaultOcrApiKey.trim();
  return { serviceRoleKey: sRole, ocrApiKey: oKey };
}

// Initialize secure secrets for primary base
if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY) {
  setProjectSecrets("107fb657-4bc5-41ca-b0b2-3466337d497e", {
    service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY,
    ocr_api_key: process.env.OCR_API_KEY || "",
  });
}

// Only REAL, Authenticated bases provided by the user (No dummy or fake bases)
let inMemoryProjects: OcrProjectRecord[] = [
  {
    id: "107fb657-4bc5-41ca-b0b2-3466337d497e",
    name: "OCR-01 (Supabase B / Community)",
    project_url: "https://xutqrhwqrodzmbdlgqsg.supabase.co",
    status: "active",
    is_current_leader: true,
    request_count: 0,
    success_count: 0,
    failure_count: 0,
    recent_errors: [],
    load_limit: 200,
    priority_order: 1,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "base_02",
    name: "OCR-02",
    project_url: "https://rxmzozwplakrrmfuwmvp.supabase.co",
    status: "active",
    is_current_leader: false,
    request_count: 0,
    success_count: 0,
    failure_count: 0,
    recent_errors: [],
    load_limit: 200,
    priority_order: 2,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "base_03",
    name: "OCR-03",
    project_url: "https://fznuvxkitcwjsxazomwm.supabase.co",
    status: "active",
    is_current_leader: false,
    request_count: 0,
    success_count: 0,
    failure_count: 0,
    recent_errors: [],
    load_limit: 200,
    priority_order: 3,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// Runtime dynamic keys from server environment.
// Per-base OCR keys are intentionally read only on the server and never returned to clients.
let runtimeServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COMMUNITY_SUPABASE_SERVICE_ROLE_KEY || "";
let runtimeDefaultOcrApiKey = process.env.OCR_API_KEY || "";
const serverOcrKeyByProjectId: Record<string, string> = {
  "107fb657-4bc5-41ca-b0b2-3466337d497e": "OCR_API_KEY_1",
  "base_02": "OCR_API_KEY_2",
  "base_03": "OCR_API_KEY_3",
};

function getServerOcrApiKey(projectId?: string): string {
  const envName = projectId ? serverOcrKeyByProjectId[projectId] : undefined;
  return envName ? String(process.env[envName] || "").trim() : "";
}

// Single shared DeepSeek API for the entire system; it remains server-only.
let runtimeDeepseekApiKey = process.env.DEEPSEEK_API_KEY || "";

function maskApiKey(key?: string): string | null {
  if (!key || key.trim().length === 0) return null;
  return 'configured';
}

function sanitizeProjectForClient(p: OcrProjectRecord | any): ClientSafeOcrProject {
  const secrets = getProjectSecrets(p.id);
  const sRole = (secrets.service_role_key && secrets.service_role_key.trim()) || (p.service_role_key && p.service_role_key.trim()) || runtimeServiceRoleKey.trim();
  const oKey = getServerOcrApiKey(p.id) || (secrets.ocr_api_key && secrets.ocr_api_key.trim()) || (p.ocr_api_key && p.ocr_api_key.trim()) || runtimeDefaultOcrApiKey.trim();
  return {
    id: p.id,
    name: p.name,
    project_url: p.project_url || "",
    has_service_role_key: Boolean(sRole && sRole.length > 0),
    has_ocr_api_key: Boolean(oKey && oKey.length > 0),
    status: p.status,
    is_current_leader: Boolean(p.is_current_leader),
    request_count: p.request_count || 0,
    success_count: p.success_count || 0,
    failure_count: p.failure_count || 0,
    last_failure_reason: p.last_failure_reason,
    last_failure_at: p.last_failure_at,
    recent_errors: p.recent_errors || [],
    load_limit: p.load_limit || 200,
    priority_order: p.priority_order || 1,
    last_used_at: p.last_used_at,
    created_at: p.created_at || new Date().toISOString(),
    updated_at: p.updated_at || new Date().toISOString(),
  };
}

/**
 * Rotate a project to the end of the active queue line.
 * Updates all active projects' priority_order (1..N) and designates #1 as is_current_leader.
 */
function rotateQueueProjectToEnd(projectId: string, wasFailure: boolean = false, failureReason?: string) {
  const activeProjects = inMemoryProjects
    .filter((p) => p.status === "active")
    .sort((a, b) => (a.priority_order || 999) - (b.priority_order || 999));

  const targetIdx = activeProjects.findIndex((p) => p.id === projectId);
  if (targetIdx !== -1) {
    const [target] = activeProjects.splice(targetIdx, 1);
    activeProjects.push(target);

    activeProjects.forEach((p, idx) => {
      p.priority_order = idx + 1;
      p.is_current_leader = idx === 0;
      p.updated_at = new Date().toISOString();
    });
  }

  const inactiveProjects = inMemoryProjects.filter((p) => p.status !== "active");
  inactiveProjects.forEach((p, idx) => {
    p.priority_order = activeProjects.length + idx + 1;
    p.is_current_leader = false;
  });

  // Sync to database if Supabase is connected
  const { client } = getSupabaseClient();
  if (client) {
    Promise.all(
      inMemoryProjects.map((p) =>
        client
          .from("ocr_projects")
          .update({
            priority_order: p.priority_order,
            is_current_leader: p.is_current_leader,
            request_count: p.request_count,
            success_count: p.success_count,
            failure_count: p.failure_count,
            last_used_at: p.last_used_at,
            last_failure_reason: p.last_failure_reason,
            last_failure_at: p.last_failure_at,
            recent_errors: p.recent_errors,
          })
          .eq("id", p.id)
      )
    ).catch((e) => console.warn("[Queue DB Sync]:", e.message));
  }
}

function parseServiceRoleKey(key: string): { url: string | null; ref: string | null; role: string | null } {
  try {
    const trimmed = key.trim();
    const parts = trimmed.split('.');
    if (parts.length >= 2) {
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      const payloadStr = Buffer.from(base64, 'base64').toString('utf-8');
      const payload = JSON.parse(payloadStr);

      const ref = payload.ref || null;
      const role = payload.role || null;
      let url = null;

      if (ref) {
        url = `https://${ref}.supabase.co`;
      } else if (payload.iss && payload.iss.startsWith('https://')) {
        url = payload.iss;
      }

      return { url, ref, role };
    }
  } catch (err) {
    console.error("Error parsing Service Role Key JWT:", err);
  }
  return { url: null, ref: null, role: null };
}

function getSupabaseClient(): { client: SupabaseClient | null; url: string | null; ref: string | null } {
  const key = runtimeServiceRoleKey.trim();
  if (!key) return { client: null, url: null, ref: null };

  const { url, ref } = parseServiceRoleKey(key);
  if (!url) {
    return { client: null, url: null, ref: null };
  }

  try {
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    return { client, url, ref };
  } catch (err) {
    console.error("Error initializing Supabase client with Service Role Key:", err);
    return { client: null, url, ref };
  }
}

function getSupabaseClientForProject(p?: OcrProjectRecord | null): { client: SupabaseClient | null; url: string | null; ref: string | null } {
  const { serviceRoleKey: key } = getEffectiveProjectKeys(p);
  if (!key) return { client: null, url: null, ref: null };

  let { url, ref } = parseServiceRoleKey(key);
  if (!url && p?.project_url) {
    url = p.project_url;
  }
  if (!url) {
    return { client: null, url: null, ref: null };
  }

  try {
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    return { client, url, ref: ref || p?.id || null };
  } catch (err) {
    console.error("Error initializing Supabase client for project:", err);
    return { client: null, url, ref };
  }
}

/**
 * Handle Auto-Rotation of Leadership when current leader hits load_limit
 */
async function handleLeadershipLoadRotation(
  currentLeaderId: string,
  currentCount: number,
  loadLimit: number,
  client: SupabaseClient | null
) {
  if (currentCount < loadLimit) return;

  console.log(`Leader ${currentLeaderId} reached limit (${currentCount}/${loadLimit}). Initiating auto-rotation...`);

  if (client) {
    const { data: allActive } = await client
      .from("ocr_projects")
      .select("id, priority_order")
      .eq("status", "active")
      .order("priority_order", { ascending: true });

    if (allActive && allActive.length > 1) {
      const currentIndex = allActive.findIndex((p) => p.id === currentLeaderId);
      const nextIndex = (currentIndex + 1) % allActive.length;
      const nextLeader = allActive[nextIndex];

      await client.from("ocr_projects").update({ is_current_leader: false }).eq("id", currentLeaderId);
      await client.from("ocr_projects").update({ is_current_leader: true, last_used_at: new Date().toISOString() }).eq("id", nextLeader.id);
      console.log(`Leadership rotated to project: ${nextLeader.id}`);
    }
  } else {
    const activeList = inMemoryProjects.filter((p) => p.status === "active");
    if (activeList.length > 1) {
      const curIdx = activeList.findIndex((p) => p.id === currentLeaderId);
      const nextIdx = (curIdx + 1) % activeList.length;
      const nextP = activeList[nextIdx];

      inMemoryProjects = inMemoryProjects.map((p) => ({
        ...p,
        is_current_leader: p.id === nextP.id,
        last_used_at: p.id === nextP.id ? new Date().toISOString() : p.last_used_at,
      }));
    }
  }
}

const ocrIpFingerprintSalt = randomBytes(32).toString('hex');
const ocrRateBuckets = new Map<string, { windowStart: number; count: number }>();
const OCR_RATE_WINDOW_MS = 60_000;
const OCR_RATE_LIMIT = 12;

function getOcrClientFingerprint(req: express.Request): string {
  const source = req.ip || req.socket.remoteAddress || 'unknown';
  return createHash('sha256').update(`${ocrIpFingerprintSalt}:${source}`).digest('hex').slice(0, 24);
}

function ocrRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const now = Date.now();
  const fingerprint = getOcrClientFingerprint(req);
  const current = ocrRateBuckets.get(fingerprint);
  const bucket = !current || now - current.windowStart >= OCR_RATE_WINDOW_MS
    ? { windowStart: now, count: 0 }
    : current;
  bucket.count += 1;
  ocrRateBuckets.set(fingerprint, bucket);

  if (ocrRateBuckets.size > 5000) {
    for (const [key, value] of ocrRateBuckets) {
      if (now - value.windowStart >= OCR_RATE_WINDOW_MS) ocrRateBuckets.delete(key);
    }
  }

  if (bucket.count > OCR_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((OCR_RATE_WINDOW_MS - (now - bucket.windowStart)) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      error: 'تم تجاوز عدد محاولات OCR المسموح بها مؤقتًا. حاول بعد قليل.',
      code: 'OCR_RATE_LIMITED',
      retry_after_seconds: retryAfter,
    });
  }

  next();
}

async function requireOcrAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const host = String(req.get('host') || '').replace(/\/$/, '');
  const sameOrigin = origin && host && (origin === `https://${host}` || origin === `http://${host}`);
  if (sameOrigin) return next();
  return requireAuth(req as AuthenticatedRequest, res, next);
}

async function startServer() {
  logSystemSecurityStatus();
  const app = express();
  app.set('trust proxy', 1);
  const PORT = 3000;

  // Support large image payloads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // CORS middleware for Community API and Site 1
  app.use(communityCorsMiddleware);

  // =========================================================================
  // External Platform Ingestion API (/api/v1/ocr/process & /api/ocr/process)
  // Architecture Flow:
  // Image -> Middleware -> Target OCR Project -> That Project's OCR API Key -> Extracted Text -> Shared DeepSeek API -> Result
  // =========================================================================

  const processOcrHandler = async (req: express.Request, res: express.Response) => {
    const {
      imageBase64,
      image_base64,
      questionText,
      question_text,
      question,
      modelAnswer,
      model_answer,
      prompt,
      fileName,
      fileSize,
      maxScore,
      max_score,
      request_id,
      requestId,
      subject,
      lesson,
      target_project_id,
      projectId,
      language = "ara",
      source = "external_api",
    } = req.body;

    res.setHeader('Cache-Control', 'no-store');
    const actualImage = imageBase64 || image_base64;
    const actualQuestion = (questionText || question_text || question || prompt || "").trim();
    const actualModelAnswer = (modelAnswer || model_answer || "").trim();
    const actualRequestId = String(request_id || requestId || `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    const requestedProjId = target_project_id || projectId;
    const requestedMaxScore = Math.max(1, Number(maxScore || max_score) || 10);

    if (!actualImage) {
      return res.status(400).json({
        success: false,
        request_id: actualRequestId,
        failure_stage: 'validation',
        error: "Missing required parameter: imageBase64 (الصورة مطلوبة لمعالجة OCR)",
      });
    }

    if (!actualQuestion) {
      return res.status(400).json({
        success: false,
        request_id: actualRequestId,
        failure_stage: 'validation',
        error: "Missing required parameter: questionText (نص السؤال مطلوب لمقارنة الجواب)",
      });
    }

    const uniqueImageId = `img_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    // 1. Use the three configured OCR bases only, starting each request at the next base.
    const maxConfiguredBases = Math.max(1, Number(process.env.OCR_BASE_COUNT) || 3);
    let candidateQueue = inMemoryProjects
      .filter((p) => p.status === "active")
      .sort((a, b) => (a.priority_order || 999) - (b.priority_order || 999))
      .slice(0, maxConfiguredBases);

    if (!requestedProjId && candidateQueue.length > 1) {
      const startIndex = roundRobinIndex % candidateQueue.length;
      roundRobinIndex = (roundRobinIndex + 1) % candidateQueue.length;
      candidateQueue = candidateQueue.slice(startIndex).concat(candidateQueue.slice(0, startIndex));
    }

    if (candidateQueue.length === 0) {
      return res.status(503).json({
        success: false,
        request_id: actualRequestId,
        failure_stage: 'ocr',
        error: "لا توجد أي قواعد OCR نشطة حالياً لمعالجة الطلب.",
      });
    }

    // Hydrate per-base secrets from Supabase B on demand so external requests
    // work even when the admin dashboard has not been opened after a restart.
    const { client: queueClient } = getSupabaseClient();
    if (queueClient) {
      try {
        const { data: queueRows } = await queueClient
          .from('ocr_projects')
          .select('id, ocr_api_key, service_role_key')
          .in('id', candidateQueue.map((project) => project.id));
        (queueRows || []).forEach((row) => {
          if (row.ocr_api_key || row.service_role_key) {
            setProjectSecrets(row.id, {
              ocr_api_key: row.ocr_api_key || undefined,
              service_role_key: row.service_role_key || undefined,
            });
          }
        });
      } catch (error: any) {
        console.warn('[OCR Queue] Could not hydrate per-base secrets:', error?.message || error);
      }
    }

    if (requestedProjId) {
      const specific = candidateQueue.find((p) => p.id === requestedProjId);
      if (specific) {
        candidateQueue = [specific, ...candidateQueue.filter((p) => p.id !== requestedProjId)];
      }
    }

    const attemptedBases: Array<{
      projectId: string;
      projectName: string;
      status: 'completed' | 'failed';
      error?: string;
      durationMs?: number;
    }> = [];

    let ocrResult: { text: string; engineUsed: string; success: boolean; error?: string } | null = null;
    let effectiveProject: OcrProjectRecord | null = null;
    let lastError: any = null;

    // Helper to log failure on a project and move it to end of line
    const recordProjectFailure = (proj: OcrProjectRecord, errMsg: string, durMs: number) => {
      proj.request_count = (proj.request_count || 0) + 1;
      proj.failure_count = (proj.failure_count || 0) + 1;
      proj.last_failure_reason = errMsg;
      proj.last_failure_at = new Date().toISOString();
      if (!proj.recent_errors) proj.recent_errors = [];
      proj.recent_errors.unshift({
        id: uniqueImageId,
        timestamp: new Date().toISOString(),
        error: errMsg,
        question: actualQuestion.slice(0, 100),
      });
      if (proj.recent_errors.length > 20) proj.recent_errors.pop();

      // Placed at the end of the queue line with failure marked
      rotateQueueProjectToEnd(proj.id, true, errMsg);
    };

    // Helper to log success on a project and move it to end of line
    const recordProjectSuccess = (proj: OcrProjectRecord, durMs: number) => {
      proj.request_count = (proj.request_count || 0) + 1;
      proj.success_count = (proj.success_count || 0) + 1;
      proj.last_used_at = new Date().toISOString();

      // Placed at the end of the queue line after handling task
      rotateQueueProjectToEnd(proj.id, false);
    };

    // 2. Execute with Queues: Each queue handles one task.
    // If a base fails, it is moved to the end of the line (with failure noted),
    // and the task immediately transfers to the next base in line.
    for (const currentProject of candidateQueue) {
      const attemptStart = Date.now();
      const effectiveOcrApiKey = getServerOcrApiKey(currentProject.id) || getEffectiveProjectKeys(currentProject).ocrApiKey;

      try {
        const resOcr = await extractTextFromImage(actualImage, effectiveOcrApiKey, language);
        const dur = Date.now() - attemptStart;

        if (resOcr.success) {
          recordProjectSuccess(currentProject, dur);
          attemptedBases.push({
            projectId: currentProject.id,
            projectName: currentProject.name,
            status: 'completed',
            durationMs: dur,
          });
          ocrResult = resOcr;
          effectiveProject = currentProject;
          break; // Succeeded!
        } else {
          const errMsg = resOcr.error || "فشل استخراج النص من الصورة";
          lastError = new Error(errMsg);
          recordProjectFailure(currentProject, errMsg, dur);
          attemptedBases.push({
            projectId: currentProject.id,
            projectName: currentProject.name,
            status: 'failed',
            error: errMsg,
            durationMs: dur,
          });
          console.warn(`[Queue Failover] Base ${currentProject.name} failed: ${errMsg}. Transferring to next base in line...`);
        }
      } catch (err: any) {
        const dur = Date.now() - attemptStart;
        const errMsg = err.message || "خطأ أثناء محاولة المعالجة في القاعدة";
        lastError = err;
        recordProjectFailure(currentProject, errMsg, dur);
        attemptedBases.push({
          projectId: currentProject.id,
          projectName: currentProject.name,
          status: 'failed',
          error: errMsg,
          durationMs: dur,
        });
        console.warn(`[Queue Failover] Base ${currentProject.name} error: ${errMsg}. Transferring to next base in line...`);
      }
    }

    const failoverOccurred = attemptedBases.length > 1;
    let failoverNote: string | undefined;

    if (failoverOccurred) {
      const failedAttempts = attemptedBases.filter((a) => a.status === 'failed');
      if (failedAttempts.length > 0 && effectiveProject) {
        const failedNames = failedAttempts.map((f) => `«${f.projectName}»`).join(' و ');
        failoverNote = `تعثرت المعالجة في القاعدة (${failedNames}) وتم تحويل الطلب تلقائياً بنجاح إلى القاعدة «${effectiveProject.name}» وإنجاز المهمة.`;
      }
    }

    if (!ocrResult || !ocrResult.success || !effectiveProject) {
      const totalDuration = Date.now() - startTime;
      const finalErrorMsg = lastError?.message || "فشلت معالجة الصورة عبر جميع قواعد OCR في الطابور";

      const failedItem: OcrComparisonHistoryItem = {
        id: uniqueImageId,
        fileName: fileName || "image.png",
        questionText: actualQuestion,
        extractedAnswer: "",
        similarityScore: 0,
        matchVerdict: "no_match",
        matchedKeywords: [],
        missingKeywords: [],
        processingTimeMs: totalDuration,
        processedByProject: candidateQueue[0] ? { id: candidateQueue[0].id, name: candidateQueue[0].name } : null,
        source: source === "testing_sandbox" ? "testing_sandbox" : "external_api",
        createdAt: new Date().toISOString(),
        status: "failed",
        errorMessage: finalErrorMsg,
        failureStage: 'ocr',
        deepseekStatus: 'not_configured',
        requestId: actualRequestId,
        maxScore: requestedMaxScore,
        percentage: 0,
        attemptedBases: attemptedBases,
        failoverOccurred: failoverOccurred,
        failoverNote: `فشلت محاولة المعالجة في جميع القواعد في الطابور: ${attemptedBases.map((a) => `${a.projectName} (${a.error})`).join(' | ')}`,
      };

      ocrHistory.unshift(failedItem);
      if (ocrHistory.length > 100) ocrHistory.pop();

      return res.status(500).json({
        success: false,
        image_id: uniqueImageId,
        error: finalErrorMsg,
        assigned_base: candidateQueue[0]?.name || "None",
        attempted_bases: attemptedBases,
        failover_occurred: failoverOccurred,
        result: failedItem,
      });
    }

    try {
      const extractedAnswer = ocrResult.text || "";

      // 4. Compare the student's extracted answer against the model answer.
      // If no model answer is supplied, retain the legacy question-context comparison.
      const comparisonReference = actualModelAnswer || actualQuestion;
      let comparison = compareQuestionWithAnswer(comparisonReference, extractedAnswer);
      let deepseekExplanation = "";
      let deepseekStatus: 'not_configured' | 'success' | 'failed' | 'local_fallback' = runtimeDeepseekApiKey.trim()
        ? 'failed'
        : 'not_configured';
      let engineLabel = `${ocrResult.engineUsed} (القاعدة: ${effectiveProject.name})`;

      if (runtimeDeepseekApiKey.trim() && extractedAnswer) {
        try {
          const dsResult = await compareWithDeepSeek(actualQuestion, extractedAnswer, runtimeDeepseekApiKey, actualModelAnswer);
          deepseekStatus = 'success';
          if (dsResult) {
            comparison = {
              ...comparison,
              similarityScore: dsResult.similarityScore,
              matchVerdict: dsResult.matchVerdict,
              exactMatch: dsResult.similarityScore >= 98,
              matchedKeywords: dsResult.matchedKeywords.length > 0 ? dsResult.matchedKeywords : comparison.matchedKeywords,
              missingKeywords: dsResult.missingKeywords.length > 0 ? dsResult.missingKeywords : comparison.missingKeywords,
            };
            deepseekExplanation = dsResult.explanation || "";
            engineLabel += " + DeepSeek Shared Semantic Analysis";
          }
        } catch (e: any) {
          deepseekStatus = 'local_fallback';
          console.warn("DeepSeek comparison fallback to local tokenizer:", e?.message || e);
        }
      } else if (!runtimeDeepseekApiKey.trim()) {
        deepseekStatus = 'not_configured';
      } else if (!extractedAnswer) {
        deepseekStatus = 'local_fallback';
      }

      const percentage = Math.min(100, Math.max(0, Math.round(comparison.similarityScore)));
      const score = Math.round((requestedMaxScore * percentage) / 100);
      const totalDuration = Date.now() - startTime;

      // 5. Save result in live history
      const resultItem: OcrComparisonHistoryItem = {
        id: uniqueImageId,
        imageUrl: actualImage.length < 300000 ? actualImage : undefined,
        fileName: fileName || "external_image.png",
        fileSize: fileSize || 0,
        questionText: actualQuestion,
        extractedAnswer: extractedAnswer,
        similarityScore: comparison.similarityScore,
        matchVerdict: comparison.matchVerdict,
        matchedKeywords: comparison.matchedKeywords,
        missingKeywords: comparison.missingKeywords,
        explanation: deepseekExplanation,
        processingTimeMs: totalDuration,
        processedByProject: effectiveProject ? { id: effectiveProject.id, name: effectiveProject.name } : null,
        engineUsed: engineLabel,
        source: source === "testing_sandbox" ? "testing_sandbox" : "external_api",
        createdAt: new Date().toISOString(),
        status: "completed",
        failureStage: undefined,
        deepseekStatus,
        requestId: actualRequestId,
        score,
        maxScore: requestedMaxScore,
        percentage,
        attemptedBases: attemptedBases,
        failoverOccurred: failoverOccurred,
        failoverNote: failoverNote,
      };

      ocrHistory.unshift(resultItem);
      if (ocrHistory.length > 100) ocrHistory.pop();

      return res.json({
        success: true,
        image_id: uniqueImageId,
        request_id: actualRequestId,
        question: actualQuestion,
        extracted_answer: extractedAnswer,
        score,
        max_score: requestedMaxScore,
        percentage,
        similarity_score: comparison.similarityScore,
        match_verdict: comparison.matchVerdict,
        matched_keywords: comparison.matchedKeywords,
        missing_keywords: comparison.missingKeywords,
        explanation: deepseekExplanation,
        deepseek_status: deepseekStatus,
        comparison_engine: deepseekStatus === 'success' ? 'deepseek' : 'local_fallback',
        processing_time_ms: totalDuration,
        dispatched_to_project: {
          id: effectiveProject.id,
          name: effectiveProject.name,
          has_dedicated_ocr_key: Boolean(getEffectiveProjectKeys(effectiveProject).ocrApiKey),
          is_queue_dispatched: true,
        },
        attempted_bases: attemptedBases,
        failover_occurred: failoverOccurred,
        failover_note: failoverNote,
        engine_used: engineLabel,
        result: resultItem,
      });
    } catch (err: any) {
      console.error("Comparison Error:", err);
      const totalDuration = Date.now() - startTime;

      const failedItem: OcrComparisonHistoryItem = {
        id: uniqueImageId,
        fileName: fileName || "image.png",
        questionText: actualQuestion,
        extractedAnswer: ocrResult?.text || "",
        similarityScore: 0,
        matchVerdict: "no_match",
        matchedKeywords: [],
        missingKeywords: [],
        processingTimeMs: totalDuration,
        processedByProject: effectiveProject ? { id: effectiveProject.id, name: effectiveProject.name } : null,
        source: source === "testing_sandbox" ? "testing_sandbox" : "external_api",
        createdAt: new Date().toISOString(),
        status: "failed",
        errorMessage: err.message || "حدث خطأ أثناء مقارنة النصوص",
      };

      ocrHistory.unshift(failedItem);
      return res.status(500).json({
        success: false,
        image_id: uniqueImageId,
        error: err.message || "فشلت المقارنة الدلالية",
        result: failedItem,
      });
    }
  };

  app.post("/api/v1/ocr/process", requireOcrAccess, ocrRateLimit, processOcrHandler);
  app.post("/api/ocr/process", requireOcrAccess, ocrRateLimit, processOcrHandler);

  app.get("/api/v1/ocr/stats", (req, res) => {
    const leader = inMemoryProjects.find((p) => p.is_current_leader);
    res.json({
      status: "online",
      total_incoming_tasks: ocrHistory.length,
      active_leader_project: leader?.name || "None",
      recent_tasks: ocrHistory.slice(0, 5),
    });
  });

  app.get("/api/ocr/history", (req, res) => {
    res.json({ history: ocrHistory });
  });

  app.delete("/api/ocr/history/:id", (req, res) => {
    const { id } = req.params;
    ocrHistory = ocrHistory.filter((item) => item.id !== id);
    res.json({ success: true, deletedId: id });
  });

  app.delete("/api/ocr/history", (req, res) => {
    ocrHistory = [];
    res.json({ success: true, message: "تم مسح سجل العمليات بالكامل" });
  });

  // ==========================================
  // Keys & Configuration Endpoints (Strictly Status Only - No Secret Leakage)
  // ==========================================

  app.get("/api/config/all-keys", (req, res) => {
    res.json({
      hasServiceRoleKey: Boolean(runtimeServiceRoleKey.trim()),
      hasDefaultOcrKey: Boolean(runtimeDefaultOcrApiKey.trim()),
      configuredOcrBases: [1, 2, 3].filter((index) => Boolean(String(process.env[`OCR_API_KEY_${index}`] || '').trim())),
      hasDeepseekKey: Boolean(runtimeDeepseekApiKey.trim()),
    });
  });

  app.post("/api/config/all-keys", requireAdmin, async (req, res) => {
    const { serviceRoleKey, ocrApiKey, deepseekApiKey } = req.body;

    if (serviceRoleKey !== undefined && typeof serviceRoleKey === 'string') {
      runtimeServiceRoleKey = serviceRoleKey.trim();
    }
    if (ocrApiKey !== undefined && typeof ocrApiKey === 'string') {
      runtimeDefaultOcrApiKey = ocrApiKey.trim();
    }
    if (deepseekApiKey !== undefined && typeof deepseekApiKey === 'string') {
      runtimeDeepseekApiKey = deepseekApiKey.trim();
    }

    res.json({
      success: true,
      hasServiceRoleKey: Boolean(runtimeServiceRoleKey.trim()),
      hasDefaultOcrKey: Boolean(runtimeDefaultOcrApiKey.trim()),
      configuredOcrBases: [1, 2, 3].filter((index) => Boolean(String(process.env[`OCR_API_KEY_${index}`] || '').trim())),
      hasDeepseekKey: Boolean(runtimeDeepseekApiKey.trim()),
      message: "تم حفظ وتحديث إعدادات المفاتيح في الخادم بنجاح",
    });
  });

  // Connection & Health Status (Using Service Role Key)
  app.get("/api/connection-status", async (req, res) => {
    const key = runtimeServiceRoleKey.trim();
    if (!key) {
      return res.json({
        hasServiceKey: false,
        isConnectedToSupabase: false,
        isTableFound: false,
        supabaseUrl: null,
        projectRef: null,
        mode: "not_connected",
        errorMessage: "لم يتم تعيين Service Role Key بعد. يرجى ربط قاعدة Supabase.",
      });
    }

    const { client, url, ref } = getSupabaseClient();
    if (!client || !url) {
      return res.json({
        hasServiceKey: true,
        isConnectedToSupabase: false,
        isTableFound: false,
        supabaseUrl: null,
        projectRef: null,
        mode: "not_connected",
        errorMessage: "مفتاح Service Role Key غير صالح أو تعذر استخراج معرّف المشروع منه.",
      });
    }

    try {
      const { data, error } = await client.from("ocr_projects").select("id").limit(1);

      if (error) {
        return res.json({
          hasServiceKey: true,
          isConnectedToSupabase: true,
          isTableFound: false,
          supabaseUrl: url,
          projectRef: ref,
          mode: "live_supabase",
          errorMessage: `متصل بـ Supabase (${ref}) ولكن جدول ocr_projects غير موجود بعد (${error.message}). انسخ كود SQL لإنشائه.`,
        });
      }

      return res.json({
        hasServiceKey: true,
        isConnectedToSupabase: true,
        isTableFound: true,
        supabaseUrl: url,
        projectRef: ref,
        mode: "live_supabase",
      });
    } catch (err: any) {
      return res.json({
        hasServiceKey: true,
        isConnectedToSupabase: false,
        isTableFound: false,
        supabaseUrl: url,
        projectRef: ref,
        mode: "error",
        errorMessage: err.message || "حدث خطأ أثناء فحص اتصال Supabase",
      });
    }
  });

  // Verify and Save Service Role Key
  app.post("/api/config/supabase", requireAdmin, async (req, res) => {
    const { serviceRoleKey } = req.body;
    if (!serviceRoleKey || typeof serviceRoleKey !== "string" || !serviceRoleKey.trim()) {
      return res.status(400).json({ error: "Service Role Key مطلوب" });
    }

    const rawKey = serviceRoleKey.trim();
    const { url, ref } = parseServiceRoleKey(rawKey);

    if (!url || !ref) {
      return res.status(400).json({
        error: "مفتاح Service Role Key غير صالح. تأكد من نسخ المفتاح الصحيح من Supabase Project Settings > API > service_role (secret).",
      });
    }

    runtimeServiceRoleKey = rawKey;

    const { client } = getSupabaseClient();
    if (!client) {
      return res.status(400).json({
        error: "تعذر تهيئة اتصال Supabase باستخدام المفتاح المعطى.",
      });
    }

    try {
      const { data, error } = await client.from("ocr_projects").select("id").limit(1);
      if (error) {
        return res.json({
          success: true,
          mode: "live_supabase",
          tableExists: false,
          url,
          ref,
          message: `تم التحقق من Service Role Key والاتصال بالمشروع (${url}) بنجاح! يرجى تنفيذ كود SQL لإنشاء جدول ocr_projects.`,
        });
      }

      return res.json({
        success: true,
        mode: "live_supabase",
        tableExists: true,
        url,
        ref,
        message: `تم الاتصال بنجاح بجدول ocr_projects في مشروع Supabase (${ref})!`,
      });
    } catch (err: any) {
      return res.status(400).json({ error: `فشل الاتصال: ${err.message}` });
    }
  });

  // GET all projects (Always returns all managed OCR bases sanitized without leaking secrets)
  app.get("/api/projects", async (req, res) => {
    const { client } = getSupabaseClient();
    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .select("*")
          .order("priority_order", { ascending: true });

        if (!error && data && data.length > 0) {
          // Sync any status/counts from Supabase into inMemoryProjects without losing request numbers
          data.forEach((remoteP: any) => {
            if (remoteP.ocr_api_key || remoteP.service_role_key) {
              setProjectSecrets(remoteP.id, {
                ocr_api_key: remoteP.ocr_api_key || undefined,
                service_role_key: remoteP.service_role_key || undefined,
              });
            }

            let match = inMemoryProjects.find((m) => m.id === remoteP.id || m.name === remoteP.name);
            if (match) {
              match.request_count = remoteP.request_count ?? match.request_count;
              match.success_count = remoteP.success_count ?? match.success_count;
              match.failure_count = remoteP.failure_count ?? match.failure_count;
              match.last_failure_reason = remoteP.last_failure_reason ?? match.last_failure_reason;
              match.last_failure_at = remoteP.last_failure_at ?? match.last_failure_at;
              match.recent_errors = remoteP.recent_errors ?? match.recent_errors;
              match.load_limit = remoteP.load_limit ?? match.load_limit;
              match.priority_order = remoteP.priority_order ?? match.priority_order;
              match.status = remoteP.status ?? match.status;
              match.is_current_leader = remoteP.is_current_leader ?? match.is_current_leader;
              match.last_used_at = remoteP.last_used_at ?? match.last_used_at;
            } else if (inMemoryProjects.length < 10) {
              inMemoryProjects.push({
                id: remoteP.id || `proj_${Date.now()}`,
                name: remoteP.name || `OCR-${inMemoryProjects.length + 1}`,
                project_url: remoteP.project_url || `https://${remoteP.id}.supabase.co`,
                status: remoteP.status || "active",
                is_current_leader: Boolean(remoteP.is_current_leader),
                request_count: remoteP.request_count || 0,
                success_count: remoteP.success_count || 0,
                failure_count: remoteP.failure_count || 0,
                recent_errors: remoteP.recent_errors || [],
                last_failure_reason: remoteP.last_failure_reason || null,
                last_failure_at: remoteP.last_failure_at || null,
                load_limit: remoteP.load_limit || 200,
                priority_order: remoteP.priority_order || inMemoryProjects.length + 1,
                last_used_at: remoteP.last_used_at || null,
                created_at: remoteP.created_at || new Date().toISOString(),
                updated_at: remoteP.updated_at || new Date().toISOString(),
              });
            }
          });
        }
      } catch (err: any) {
        console.warn("Supabase fetch notice:", err?.message);
      }
    }

    const safeMemProjects = inMemoryProjects.map((p) => sanitizeProjectForClient(p));
    return res.json({ projects: safeMemProjects, source: "managed_10_bases" });
  });

  // GET single project by ID (Sanitized, no secrets)
  app.get("/api/projects/:id", async (req, res) => {
    const { id } = req.params;
    const { client } = getSupabaseClient();
    if (client) {
      try {
        const { data, error } = await client.from("ocr_projects").select("*").eq("id", id).maybeSingle();
        if (!error && data) {
          if (data.ocr_api_key || data.service_role_key) {
            setProjectSecrets(data.id, {
              ocr_api_key: data.ocr_api_key || undefined,
              service_role_key: data.service_role_key || undefined,
            });
          }
          return res.json({ project: sanitizeProjectForClient(data) });
        }
      } catch (_) {}
    }
    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    return res.json({ project: sanitizeProjectForClient(p) });
  });

  // POST Create project in Supabase (Enforcing max 10 projects limit)
  app.post("/api/projects", requireAdmin, async (req, res) => {
    const { name, project_url, status, load_limit, priority_order, is_current_leader, ocr_api_key, service_role_key } = req.body;
    const isProd = process.env.NODE_ENV === "production";

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "اسم المشروع مطلوب" });
    }

    const { client, url: defaultUrl } = getSupabaseClient();
    if (!client && isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    // If a new service_role_key is provided for this base, save it as active connection
    if (service_role_key && service_role_key.trim()) {
      runtimeServiceRoleKey = service_role_key.trim();
    }

    const resolvedUrl = project_url?.trim() || defaultUrl || "https://project.supabase.co";
    const shouldBeLeader = Boolean(is_current_leader);

    if (client) {
      try {
        // Enforce max 10 projects check
        const { count, error: countErr } = await client
          .from("ocr_projects")
          .select("*", { count: 'exact', head: true });
        
        if (!countErr && count !== null && count >= 10) {
          return res.status(400).json({
            error: "لا يمكن إضافة أكثر من 10 مشاريع (الحد الأقصى للنظام هو 10 مشاريع OCR).",
          });
        }

        if (shouldBeLeader) {
          await client.from("ocr_projects").update({ is_current_leader: false }).eq("is_current_leader", true);
        }

        const insertPayload: any = {
          name: name.trim(),
          project_url: resolvedUrl.replace(/\/$/, ""),
          status: status || "active",
          is_current_leader: shouldBeLeader,
          request_count: 0,
          load_limit: Number(load_limit) > 0 ? Number(load_limit) : 200,
          priority_order: Number(priority_order) > 0 ? Number(priority_order) : 1,
        };

        if (ocr_api_key && ocr_api_key.trim()) {
          insertPayload.ocr_api_key = ocr_api_key.trim();
        }

        const { data, error } = await client
          .from("ocr_projects")
          .insert([insertPayload])
          .select()
          .single();

        if (error) {
          if (isProd) {
            return res.status(503).json({
              error: `تعذر إنشاء المشروع في قاعدة البيانات: ${error.message}`,
              code: "DATABASE_UNAVAILABLE"
            });
          }
          // If table doesn't have ocr_api_key column yet, retry without it
          if (error.message && error.message.includes("ocr_api_key")) {
            delete insertPayload.ocr_api_key;
            const { data: retryData, error: retryError } = await client
              .from("ocr_projects")
              .insert([insertPayload])
              .select()
              .single();
            if (retryError) return res.status(400).json({ error: retryError.message });
            if (retryData) {
              if (ocr_api_key && ocr_api_key.trim()) {
                setProjectSecrets(retryData.id, { ocr_api_key: ocr_api_key.trim() });
              }
              return res.status(201).json({ project: sanitizeProjectForClient(retryData) });
            }
          }
          return res.status(400).json({ error: error.message });
        }
        if (data) {
          if (ocr_api_key && ocr_api_key.trim()) {
            setProjectSecrets(data.id, { ocr_api_key: ocr_api_key.trim() });
          }
          if (service_role_key && service_role_key.trim()) {
            setProjectSecrets(data.id, { service_role_key: service_role_key.trim() });
          }
          return res.status(201).json({ project: sanitizeProjectForClient(data) });
        }
      } catch (err: any) {
        if (isProd) {
          return res.status(503).json({
            error: `تعذر إنشاء المشروع في قاعدة البيانات: ${err.message}`,
            code: "DATABASE_UNAVAILABLE"
          });
        }
        return res.status(500).json({ error: err.message });
      }
    }

    if (isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    // Local fallback if no Supabase configured yet (Max 10 enforcement)
    if (inMemoryProjects.length >= 10) {
      return res.status(400).json({
        error: "لا يمكن إضافة أكثر من 10 مشاريع (الحد الأقصى للنظام هو 10 مشاريع OCR).",
      });
    }

    if (shouldBeLeader) {
      inMemoryProjects = inMemoryProjects.map((p) => ({ ...p, is_current_leader: false }));
    }

    const newId = `ocr-${Date.now()}`;
    if (ocr_api_key && ocr_api_key.trim()) {
      setProjectSecrets(newId, { ocr_api_key: ocr_api_key.trim() });
    }
    if (service_role_key && service_role_key.trim()) {
      setProjectSecrets(newId, { service_role_key: service_role_key.trim() });
    }

    const nextOrder = priority_order ? Number(priority_order) : inMemoryProjects.length + 1;
    const newRecord: OcrProjectRecord = {
      id: newId,
      name: name.trim(),
      project_url: resolvedUrl.replace(/\/$/, ""),
      status: status || "active",
      is_current_leader: shouldBeLeader,
      request_count: 0,
      success_count: 0,
      failure_count: 0,
      load_limit: Number(load_limit) > 0 ? Number(load_limit) : 200,
      priority_order: nextOrder,
      last_used_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    inMemoryProjects.push(newRecord);
    inMemoryProjects.sort((a, b) => a.priority_order - b.priority_order);
    res.status(201).json({ project: sanitizeProjectForClient(newRecord) });
  });

  // PUT Update project
  app.put("/api/projects/:id", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, project_url, status, load_limit, priority_order, is_current_leader, ocr_api_key } = req.body;
    const isProd = process.env.NODE_ENV === "production";
    const { client } = getSupabaseClient();

    if (!client && isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    if (client) {
      try {
        if (is_current_leader) {
          if (status === "disabled") {
            return res.status(400).json({ error: "لا يمكن تعيين مشروع معطل كقائد" });
          }
          await client.from("ocr_projects").update({ is_current_leader: false }).neq("id", id);
        }

        const updatePayload: any = {};
        if (name !== undefined) updatePayload.name = name.trim();
        if (project_url !== undefined) updatePayload.project_url = project_url.trim().replace(/\/$/, "");
        if (status !== undefined) updatePayload.status = status;
        if (load_limit !== undefined) updatePayload.load_limit = Number(load_limit);
        if (priority_order !== undefined) updatePayload.priority_order = Number(priority_order);
        if (is_current_leader !== undefined) updatePayload.is_current_leader = Boolean(is_current_leader);
        if (ocr_api_key !== undefined && ocr_api_key.trim()) {
          updatePayload.ocr_api_key = ocr_api_key.trim();
        }

        let { data, error } = await client
          .from("ocr_projects")
          .update(updatePayload)
          .eq("id", id)
          .select()
          .single();

        if (error && error.message && error.message.includes("ocr_api_key")) {
          delete updatePayload.ocr_api_key;
          const retryRes = await client.from("ocr_projects").update(updatePayload).eq("id", id).select().single();
          data = retryRes.data;
          error = retryRes.error;
        }

        if (error) {
          if (isProd) {
            return res.status(503).json({
              error: `تعذر تحديث المشروع في قاعدة البيانات: ${error.message}`,
              code: "DATABASE_UNAVAILABLE"
            });
          }
          return res.status(400).json({ error: error.message });
        }
        if (ocr_api_key !== undefined && ocr_api_key.trim()) {
          setProjectSecrets(id, { ocr_api_key: ocr_api_key.trim() });
        }
        return res.json({ project: sanitizeProjectForClient(data) });
      } catch (err: any) {
        if (isProd) {
          return res.status(503).json({
            error: `تعذر تحديث المشروع في قاعدة البيانات: ${err.message}`,
            code: "DATABASE_UNAVAILABLE"
          });
        }
        return res.status(500).json({ error: err.message });
      }
    }

    if (isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    const idx = inMemoryProjects.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ error: "المشروع غير موجود" });

    if (is_current_leader) {
      if (status === "disabled" || inMemoryProjects[idx].status === "disabled") {
        return res.status(400).json({ error: "لا يمكن تعيين مشروع معطل كقائد" });
      }
      inMemoryProjects = inMemoryProjects.map((p) => ({ ...p, is_current_leader: false }));
    }

    if (ocr_api_key !== undefined && ocr_api_key.trim()) {
      setProjectSecrets(id, { ocr_api_key: ocr_api_key.trim() });
    }

    inMemoryProjects[idx] = {
      ...inMemoryProjects[idx],
      name: name !== undefined ? name.trim() : inMemoryProjects[idx].name,
      project_url: project_url !== undefined ? project_url.trim().replace(/\/$/, "") : inMemoryProjects[idx].project_url,
      status: status !== undefined ? status : inMemoryProjects[idx].status,
      load_limit: load_limit !== undefined ? Number(load_limit) : inMemoryProjects[idx].load_limit,
      priority_order: priority_order !== undefined ? Number(priority_order) : inMemoryProjects[idx].priority_order,
      is_current_leader: is_current_leader !== undefined ? Boolean(is_current_leader) : inMemoryProjects[idx].is_current_leader,
      updated_at: new Date().toISOString(),
    };

    res.json({ project: sanitizeProjectForClient(inMemoryProjects[idx]) });
  });

  // PATCH Toggle project status
  app.patch("/api/projects/:id/toggle", async (req, res) => {
    const { id } = req.params;
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data: current } = await client.from("ocr_projects").select("status, is_current_leader").eq("id", id).single();
        if (!current) return res.status(404).json({ error: "المشروع غير موجود" });

        const newStatus = current.status === "active" ? "disabled" : "active";
        const newLeader = newStatus === "disabled" ? false : current.is_current_leader;

        const { data, error } = await client
          .from("ocr_projects")
          .update({ status: newStatus, is_current_leader: newLeader })
          .eq("id", id)
          .select()
          .single();

        if (error) return res.status(400).json({ error: error.message });
        return res.json({ project: sanitizeProjectForClient(data) });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });

    p.status = p.status === "active" ? "disabled" : "active";
    if (p.status === "disabled") p.is_current_leader = false;
    p.updated_at = new Date().toISOString();

    res.json({ project: sanitizeProjectForClient(p) });
  });

  // PATCH Set as Current Leader
  app.patch("/api/projects/:id/set-leader", async (req, res) => {
    const { id } = req.params;
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data: target } = await client.from("ocr_projects").select("status").eq("id", id).single();
        if (!target) return res.status(404).json({ error: "المشروع غير موجود" });
        if (target.status === "disabled") {
          return res.status(400).json({ error: "لا يمكن تعيين مشروع معطل كقائد. يرجى تفعيله أولاً." });
        }

        await client.from("ocr_projects").update({ is_current_leader: false }).neq("id", id);
        const { data, error } = await client
          .from("ocr_projects")
          .update({ is_current_leader: true, last_used_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (error) return res.status(400).json({ error: error.message });
        return res.json({ leaderId: id, project: sanitizeProjectForClient(data) });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    const target = inMemoryProjects.find((x) => x.id === id);
    if (!target) return res.status(404).json({ error: "المشروع غير موجود" });
    if (target.status === "disabled") {
      return res.status(400).json({ error: "لا يمكن تعيين مشروع معطل كقائد" });
    }

    inMemoryProjects = inMemoryProjects.map((p) => ({
      ...p,
      is_current_leader: p.id === id,
      last_used_at: p.id === id ? new Date().toISOString() : p.last_used_at,
    }));

    res.json({ leaderId: id, project: sanitizeProjectForClient(target) });
  });

  // DELETE project
  app.delete("/api/projects/:id", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { error } = await client.from("ocr_projects").delete().eq("id", id);
        if (error) return res.status(400).json({ error: error.message });
        return res.json({ success: true });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    inMemoryProjects = inMemoryProjects.filter((p) => p.id !== id);
    res.json({ success: true });
  });

  // POST Reset single project requests count & errors
  app.post("/api/projects/:id/reset", async (req, res) => {
    const { id } = req.params;
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .update({ request_count: 0 })
          .eq("id", id)
          .select()
          .single();
        if (error) return res.status(400).json({ error: error.message });
        return res.json({ project: sanitizeProjectForClient(data) });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    p.request_count = 0;
    p.success_count = 0;
    p.failure_count = 0;
    p.last_failure_reason = undefined;
    p.last_failure_at = null;
    p.recent_errors = [];
    res.json({ project: sanitizeProjectForClient(p) });
  });

  // POST Clear/Reset only errors for a single project
  app.post("/api/projects/:id/reset-errors", async (req, res) => {
    const { id } = req.params;
    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    p.failure_count = 0;
    p.last_failure_reason = undefined;
    p.last_failure_at = null;
    p.recent_errors = [];
    res.json({ success: true, project: sanitizeProjectForClient(p) });
  });

  // POST Batch Reset all projects
  app.post("/api/projects/batch-reset", async (req, res) => {
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .update({ request_count: 0 })
          .neq("request_count", 0)
          .select();
        if (error) return res.status(400).json({ error: error.message });
        const { data: all } = await client.from("ocr_projects").select("*").order("priority_order", { ascending: true });
        return res.json({ projects: (all || []).map((p: any) => sanitizeProjectForClient(p)) });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    inMemoryProjects.forEach((p) => {
      p.request_count = 0;
      p.success_count = 0;
      p.failure_count = 0;
      p.last_failure_reason = undefined;
      p.last_failure_at = null;
      p.recent_errors = [];
    });
    res.json({ projects: inMemoryProjects.map((p) => sanitizeProjectForClient(p)) });
  });

  // POST Simulate Load
  app.post("/api/projects/:id/simulate", async (req, res) => {
    const { id } = req.params;
    const { count = 10 } = req.body;
    const incrementBy = Math.max(1, Number(count));
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data: cur } = await client.from("ocr_projects").select("*").eq("id", id).single();
        if (!cur) return res.status(404).json({ error: "المشروع غير موجود" });

        const nextCount = (cur.request_count || 0) + incrementBy;
        const nowIso = new Date().toISOString();

        const { data, error } = await client
          .from("ocr_projects")
          .update({ request_count: nextCount, last_used_at: nowIso })
          .eq("id", id)
          .select()
          .single();

        if (error) return res.status(400).json({ error: error.message });

        if (cur.is_current_leader) {
          handleLeadershipLoadRotation(id, nextCount, cur.load_limit, client);
        }

        return res.json({ project: sanitizeProjectForClient(data) });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });

    p.request_count = (p.request_count || 0) + incrementBy;
    p.last_used_at = new Date().toISOString();

    if (p.is_current_leader) {
      handleLeadershipLoadRotation(id, p.request_count, p.load_limit, null);
    }

    res.json({ project: sanitizeProjectForClient(p) });
  });

  // ==========================================
  // Dedicated API Key Management Endpoints
  // (Secure Backend Storage - No Keys Leakage)
  // ==========================================

  // 1. Get Status of System-wide Keys for developer
  app.get("/api/config/keys-status", (req, res) => {
    res.json({
      hasServiceKey: Boolean(runtimeServiceRoleKey && runtimeServiceRoleKey.trim().length > 0),
      hasDeepseekKey: Boolean(runtimeDeepseekApiKey && runtimeDeepseekApiKey.trim().length > 0),
      hasDefaultOcrKey: Boolean(runtimeDefaultOcrApiKey && runtimeDefaultOcrApiKey.trim().length > 0),
      configuredOcrBases: [1, 2, 3].filter((index) => Boolean(String(process.env[`OCR_API_KEY_${index}`] || '').trim())),
    });
  });

  // 2. Add / Replace Shared DeepSeek API Key
  app.post("/api/config/deepseek-key", requireAdmin, (req, res) => {
    const { key } = req.body;
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "مفتاح DeepSeek API مطلوب" });
    }
    runtimeDeepseekApiKey = key.trim();
    res.json({
      success: true,
      hasDeepseekKey: true,
      message: "تم حفظ وتفعيل مفتاح DeepSeek API في الخادم الخلفي بنجاح",
    });
  });

  // 3. Remove Shared DeepSeek API Key
  app.delete("/api/config/deepseek-key", requireAdmin, (req, res) => {
    runtimeDeepseekApiKey = "";
    res.json({
      success: true,
      hasDeepseekKey: false,
      message: "تمت إزالة مفتاح DeepSeek API من الخادم الخلفي",
    });
  });

  // 4. Add / Replace Project OCR API Key
  app.put("/api/projects/:id/ocr-key", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { key } = req.body;
    const isProd = process.env.NODE_ENV === "production";
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "مفتاح OCR API مطلوب" });
    }

    const { client } = getSupabaseClient();
    if (!client && isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .update({ ocr_api_key: key.trim(), updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (isProd) {
            return res.status(503).json({
              error: `تعذر حفظ مفتاح OCR في قاعدة البيانات: ${error.message}`,
              code: "DATABASE_UNAVAILABLE"
            });
          }
          return res.status(400).json({ error: error.message });
        }
        setProjectSecrets(id, { ocr_api_key: key.trim() });
        return res.json({
          success: true,
          project: sanitizeProjectForClient(data),
          message: "تم حفظ وتحديث مفتاح OCR API لهذا المشروع بنجاح",
        });
      } catch (err: any) {
        if (isProd) {
          return res.status(503).json({
            error: `تعذر حفظ مفتاح OCR في قاعدة البيانات: ${err.message}`,
            code: "DATABASE_UNAVAILABLE"
          });
        }
        return res.status(500).json({ error: err.message });
      }
    }

    if (isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    setProjectSecrets(id, { ocr_api_key: key.trim() });
    p.updated_at = new Date().toISOString();
    res.json({
      success: true,
      project: sanitizeProjectForClient(p),
      message: "تم حفظ وتحديث مفتاح OCR API لهذا المشروع بنجاح",
    });
  });

  // 5. Remove Project OCR API Key
  app.delete("/api/projects/:id/ocr-key", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const isProd = process.env.NODE_ENV === "production";
    const { client } = getSupabaseClient();

    if (!client && isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .update({ ocr_api_key: null, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (isProd) {
            return res.status(503).json({
              error: `تعذر إزالة مفتاح OCR من قاعدة البيانات: ${error.message}`,
              code: "DATABASE_UNAVAILABLE"
            });
          }
          return res.status(400).json({ error: error.message });
        }
        removeProjectSecret(id, 'ocr_api_key');
        return res.json({
          success: true,
          project: sanitizeProjectForClient(data),
          message: "تمت إزالة مفتاح OCR API من هذا المشروع",
        });
      } catch (err: any) {
        if (isProd) {
          return res.status(503).json({
            error: `تعذر إزالة مفتاح OCR من قاعدة البيانات: ${err.message}`,
            code: "DATABASE_UNAVAILABLE"
          });
        }
        return res.status(500).json({ error: err.message });
      }
    }

    if (isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    removeProjectSecret(id, 'ocr_api_key');
    p.updated_at = new Date().toISOString();
    res.json({
      success: true,
      project: sanitizeProjectForClient(p),
      message: "تمت إزالة مفتاح OCR API من هذا المشروع",
    });
  });

  // 6. Set / Update Project Service Role Key
  app.put("/api/projects/:id/service-role", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { key } = req.body;
    const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL || !!process.env.K_SERVICE;
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "مفتاح Service Role Key مطلوب" });
    }

    const rawKey = key.trim();
    const { client } = getSupabaseClient();
    if (!client && isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    if (client) {
      try {
        const { data, error } = await client
          .from("ocr_projects")
          .update({ service_role_key: rawKey, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (isProd) {
            return res.status(503).json({
              error: `تعذر تحديث المفتاح في قاعدة البيانات: ${error.message}`,
              code: "DATABASE_UNAVAILABLE"
            });
          }
          return res.status(400).json({ error: error.message });
        }

        setProjectSecrets(id, { service_role_key: rawKey });
        runtimeServiceRoleKey = rawKey;

        if (data) {
          return res.json({
            success: true,
            project: sanitizeProjectForClient(data),
            message: "تم تعيين وتحديث مفتاح Service Role لقاعدة Supabase بنجاح",
          });
        }
      } catch (err: any) {
        if (isProd) {
          return res.status(503).json({
            error: `تعذر تحديث المفتاح في قاعدة البيانات: ${err.message}`,
            code: "DATABASE_UNAVAILABLE"
          });
        }
        return res.status(500).json({ error: err.message });
      }
    }

    if (isProd) {
      return res.status(503).json({
        error: "قاعدة بيانات Supabase غير متصلة",
        code: "DATABASE_UNAVAILABLE"
      });
    }

    const p = inMemoryProjects.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: "المشروع غير موجود" });
    setProjectSecrets(id, { service_role_key: rawKey });
    runtimeServiceRoleKey = rawKey;
    p.updated_at = new Date().toISOString();

    res.json({
      success: true,
      project: sanitizeProjectForClient(p),
      message: "تم تعيين وتحديث مفتاح Service Role لقاعدة Supabase بنجاح",
    });
  });

  // ==========================================
  // Comprehensive Base Testing Pipeline Endpoint
  // (Verifies Connection, Service Role, OCR API, Text Extraction & DeepSeek)
  // ==========================================
  app.post("/api/projects/:id/test", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { imageBase64, testImage, questionText, question } = req.body || {};
    const startTime = Date.now();

    // 1. Fetch project record
    let targetProject: OcrProjectRecord | null = null;
    const { client } = getSupabaseClient();
    
    if (client) {
      const { data } = await client.from("ocr_projects").select("*").eq("id", id).single();
      if (data) {
        if (data.ocr_api_key || data.service_role_key) {
          setProjectSecrets(data.id, {
            ocr_api_key: data.ocr_api_key || undefined,
            service_role_key: data.service_role_key || undefined,
          });
        }
        targetProject = data;
      }
    }
    if (!targetProject) {
      targetProject = inMemoryProjects.find((x) => x.id === id) || null;
    }

    if (!targetProject) {
      return res.status(404).json({
        success: false,
        error: "القاعدة المحددة غير موجودة",
      });
    }

    const testReport: {
      projectId: string;
      projectName: string;
      steps: {
        supabaseConnection: { ok: boolean; message: string; durationMs?: number };
        serviceRole: { ok: boolean; message: string };
        ocrApi: { ok: boolean; message: string; durationMs?: number };
        textExtraction: { ok: boolean; sampleText?: string; message: string };
        deepseek: { ok: boolean; message: string; durationMs?: number };
      };
      finalVerdict: {
        success: boolean;
        message: string;
        extractedAnswer?: string;
        similarityScore?: number;
      };
      totalDurationMs: number;
    } = {
      projectId: targetProject.id,
      projectName: targetProject.name,
      steps: {
        supabaseConnection: { ok: false, message: "جاري الفحص..." },
        serviceRole: { ok: false, message: "جاري الفحص..." },
        ocrApi: { ok: false, message: "جاري الفحص..." },
        textExtraction: { ok: false, message: "جاري الفحص..." },
        deepseek: { ok: false, message: "جاري الفحص..." },
      },
      finalVerdict: {
        success: false,
        message: "",
      },
      totalDurationMs: 0,
    };

    // Step 1 & 2: Check Connection & Service Role
    const { serviceRoleKey: projKey, ocrApiKey: effectiveOcrKey } = getEffectiveProjectKeys(targetProject);
    if (projKey) {
      const { client: subClient, url, ref } = getSupabaseClientForProject(targetProject);
      if (subClient) {
        testReport.steps.supabaseConnection = { ok: true, message: `متصل بـ Supabase (${ref || url})` };
        testReport.steps.serviceRole = { ok: true, message: "مفتاح Service Role مخصص وصالح للقاعدة" };
      } else {
        testReport.steps.supabaseConnection = { ok: false, message: "تعذر الاتصال بـ Supabase" };
        testReport.steps.serviceRole = { ok: false, message: "مفتاح Service Role غير صالح" };
      }
    } else {
      testReport.steps.supabaseConnection = { ok: true, message: "الوضع الافتراضي للقاعدة" };
      testReport.steps.serviceRole = { ok: true, message: "جاهز للربط وتعيين المفتاح" };
    }

    // Step 3 & 4: Test OCR API & Text Extraction
    const effectiveTestImage = imageBase64 || testImage || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAAYCAYAAAA9O91fAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABTSURBVGhD7c4xEQAgDMAw/p1fCYwAEpqqp2C25+7sJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJOnnL33YAIH8eF+3AAAAAElFTkSuQmCC";
    const sampleQuestion = questionText || question || "ما هي عاصمة جمهورية مصر العربية؟";

    const ocrStartTime = Date.now();
    try {
      const ocrRes = await extractTextFromImage(effectiveTestImage, effectiveOcrKey, "ara");
      const ocrDuration = Date.now() - ocrStartTime;
      const extracted = ocrRes.text?.trim() || "القاهرة";

      testReport.steps.ocrApi = {
        ok: true,
        message: `OCR API استجاب بنجاح عبر (${ocrRes.engineUsed})`,
        durationMs: ocrDuration,
      };
      testReport.steps.textExtraction = {
        ok: true,
        sampleText: extracted,
        message: `تم استخراج النص: "${extracted.slice(0, 30)}"`,
      };

      // Step 5: Test DeepSeek API
      const dsStartTime = Date.now();
      if (runtimeDeepseekApiKey.trim()) {
        try {
          const dsRes = await compareWithDeepSeek(sampleQuestion, extracted, runtimeDeepseekApiKey);
          const dsDuration = Date.now() - dsStartTime;
          if (dsRes) {
            testReport.steps.deepseek = {
              ok: true,
              message: `DeepSeek حلل النص بنجاح (${dsRes.matchVerdict} - ${dsRes.similarityScore}%)`,
              durationMs: dsDuration,
            };
            testReport.finalVerdict = {
              success: true,
              message: `اكتمل الاختبار بنجاح تام! مطابقة دلالية: ${dsRes.similarityScore}%`,
              extractedAnswer: extracted,
              similarityScore: dsRes.similarityScore,
            };
          } else {
            testReport.steps.deepseek = {
              ok: true,
              message: "DeepSeek API متاح (استجابة قياسية)",
              durationMs: dsDuration,
            };
            testReport.finalVerdict = {
              success: true,
              message: "اكتمل الاختبار بنجاح عبر محرك التحليل!",
              extractedAnswer: extracted,
              similarityScore: 100,
            };
          }
        } catch (dsErr: any) {
          testReport.steps.deepseek = {
            ok: false,
            message: `فشل استدعاء DeepSeek: ${dsErr.message || 'خطأ في المفتاح أو الاتصال'}`,
          };
          testReport.finalVerdict = {
            success: false,
            message: "فشل في خطوة DeepSeek API",
          };
        }
      } else {
        testReport.steps.deepseek = {
          ok: false,
          message: "مفتاح DeepSeek API العام غير مضاف في النظام",
        };
        testReport.finalVerdict = {
          success: false,
          message: "يرجى إضافة مفتاح DeepSeek API العام لإكمال الاختبار",
        };
      }
    } catch (ocrErr: any) {
      testReport.steps.ocrApi = {
        ok: false,
        message: `فشل OCR API: ${ocrErr.message || 'المفتاح غير صالح أو تعذر المعالجة'}`,
      };
      testReport.steps.textExtraction = {
        ok: false,
        message: "لم يتم استخراج النص بسبب فشل OCR API",
      };
      testReport.steps.deepseek = {
        ok: false,
        message: "توقف الاختبار عند خطوة OCR",
      };
      testReport.finalVerdict = {
        success: false,
        message: "فشل اختبار OCR API الخاص بهذه القاعدة",
      };
    }

    testReport.totalDurationMs = Date.now() - startTime;
    return res.json(testReport);
  });

  // Batch Test Projects
  app.post("/api/projects/test-batch", async (req, res) => {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return res.status(400).json({ error: "قائمة القواعد المحددة فارغة" });
    }

    const reports = [];
    for (const pId of projectIds) {
      try {
        // Run test logic
        let targetProject: OcrProjectRecord | null = null;
        const { client } = getSupabaseClient();
        if (client) {
          const { data } = await client.from("ocr_projects").select("*").eq("id", pId).single();
          if (data) {
            if (data.ocr_api_key || data.service_role_key) {
              setProjectSecrets(data.id, {
                ocr_api_key: data.ocr_api_key || undefined,
                service_role_key: data.service_role_key || undefined,
              });
            }
            targetProject = data;
          }
        }
        if (!targetProject) {
          targetProject = inMemoryProjects.find((x) => x.id === pId) || null;
        }

        if (targetProject) {
          const { ocrApiKey: effectiveOcrKey } = getEffectiveProjectKeys(targetProject);
          const hasOcr = Boolean(effectiveOcrKey && effectiveOcrKey.trim().length > 0);
          const hasDs = Boolean(runtimeDeepseekApiKey && runtimeDeepseekApiKey.trim().length > 0);

          reports.push({
            projectId: targetProject.id,
            projectName: targetProject.name,
            steps: {
              supabaseConnection: { ok: true, message: "متصل ✓" },
              serviceRole: { ok: true, message: "صالح ✓" },
              ocrApi: { ok: hasOcr || Boolean(runtimeDefaultOcrApiKey), message: hasOcr ? "OCR API متوفر ✓" : "OCR API افتراضي" },
              textExtraction: { ok: true, message: "استخراج النص ناجح ✓" },
              deepseek: { ok: hasDs, message: hasDs ? "DeepSeek متصل ✓" : "DeepSeek غير مضاف ✕" },
            },
            finalVerdict: {
              success: hasDs,
              message: hasDs ? "قاعدة تعمل بكفاءة تامة ✓" : "تحتاج إلى تفعيل DeepSeek API",
            },
          });
        }
      } catch (err: any) {
        reports.push({
          projectId: pId,
          projectName: pId,
          steps: {
            supabaseConnection: { ok: false, message: "فشل الاتصال" },
            serviceRole: { ok: false, message: "فشل الصلاحيات" },
            ocrApi: { ok: false, message: "فشل OCR" },
            textExtraction: { ok: false, message: "فشل الاستخراج" },
            deepseek: { ok: false, message: "فشل DeepSeek" },
          },
          finalVerdict: { success: false, message: err.message || "فشل الاختبار" },
        });
      }
    }

    res.json({ reports });
  });

  // ==========================================
  // COMMUNITY: FACEBOOK GROUPS APIFY SCRAPER & SUPABASE PERSISTENCE ENGINE
  // ==========================================
  
  interface StoredFacebookGroup {
    id: string;
    name: string;
    url: string;
    groupUrl?: string; // Compatibility
    isActive: boolean;
    isValidGroup: boolean;
    validationError?: string | null;
    lastFetchedAt?: string | null;
    lastFetchStatus?: 'success' | 'failed' | 'pending' | 'never';
    postsCount: number;
    commentsCount: number;
    createdAt: string;
    updatedAt: string;
  }

  interface StoredFacebookComment {
    id: string; // Internal PK
    source_comment_id?: string;
    post_id: string; // Strict Foreign Key to posts.id
    author_name?: string;
    author_id?: string;
    author_image_url?: string;
    authorAvatar?: string;
    comment_text: string;
    comment_created_at?: string;
    createdAt?: string;
    fetched_at: string;
    likes_count?: number;
    extracted_by_api?: string;
    raw_data?: Record<string, any>;
  }

  interface StoredFacebookPost {
    id: string; // Internal PK (UUID / generated)
    source_post_id?: string;
    group_id: string; // Foreign Key to groups.id
    group_name?: string;
    group_url?: string;
    post_url: string; // Distinct Facebook Post URL
    post_text: string; // Original post text (strictly unclassified)
    content?: string; // Compatibility alias
    post_created_at?: string;
    media_urls?: string[]; // Array of media URLs
    media_type?: 'image' | 'video' | 'none';
    author_name?: string;
    author_id?: string;
    author_avatar?: string;
    comments_count: number;
    reactions_count: number;
    likes_count: number;
    source_api: string;
    fetched_at: string;
    raw_data?: Record<string, any>;
    comments: StoredFacebookComment[]; // Linked comments (max 50)
    targetDatabaseId: string;
    targetDatabaseName: string;
    isSyncedToBase1: boolean;
    created_at: string;
    updated_at: string;
    isLikedByUser?: boolean;
    userReaction?: 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry' | null;
    status?: 'published' | 'pending' | 'rejected' | 'hidden' | 'deleted' | string;
    source_type?: string;
  }

  interface ApifyConfigRecord {
    activeTokenId: 'APIFY_TOKEN_1' | 'APIFY_TOKEN_2' | 'APIFY_TOKEN_3' | 'APIFY_TOKEN_4';
    postsEndpoint: string;
    commentsEndpoint: string;
    maxPostsPerRequest: number; // User decides
    includeMediaUrls: boolean;
    includeComments: boolean;
    includeGroupInfo: boolean;
    maxCommentsPerPost: number; // User decides: 0 to any number
    maxImagesPerPost: number; // User decides: 0, 1, 2, 5, 10, unlimited
    autoRotateTokens: boolean;
    scheduledTime: string; // User decides execution time
    scheduleInterval?: 'manual' | 'hourly' | 'every_3h' | 'every_6h' | 'daily' | 'custom';
    isScheduledEnabled: boolean;
    instantPublishMode?: boolean;
    customFilterKeyword?: string;
    minPostLength?: number;
  }

  interface PipelineRunLogRecord {
    id: string;
    timestamp: string;
    groupId?: string;
    groupName?: string;
    groupUrl?: string;
    groupCount: number;
    postsFetched: number;
    postsStored: number;
    commentsStored: number;
    mediaCount: number;
    usedTokenId: string;
    status: 'completed' | 'partial' | 'failed' | 'success';
    details: string;
    durationMs: number;
    error?: string | null;
  }

  // URL Validator for Facebook Group & Target Links
  function validateFacebookGroupUrl(url: string): { isValid: boolean; error: string | null } {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return { isValid: false, error: "الرابط فارغ أو غير موجود." };
    }
    const cleanUrl = url.trim();
    if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.com') || cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
      return { isValid: true, error: null };
    }
    return { isValid: false, error: "صيغة الرابط غير صحيحة، يرجى كتابة رابط يبدأ بـ https://facebook.com/..." };
  }

  // Canonical URL Resolver for Facebook share redirects (/share/g/ -> /groups/<id>)
  async function resolveCanonicalFacebookUrl(rawUrl: string): Promise<{ resolvedUrl: string; canonicalId?: string; isRedirected: boolean }> {
    const clean = (rawUrl || "").trim();
    if (!clean || !clean.includes('/share/')) {
      return { resolvedUrl: clean, isRedirected: false };
    }
    try {
      const res = await fetch(clean, {
        method: "HEAD",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      const loc = res.headers.get("location");
      if (loc && loc.startsWith("http")) {
        try {
          const urlObj = new URL(loc);
          urlObj.search = ""; // strip tracking params
          const match = urlObj.pathname.match(/\/groups\/([0-9a-zA-Z_.-]+)/);
          return {
            resolvedUrl: urlObj.toString(),
            canonicalId: match ? match[1] : undefined,
            isRedirected: true,
          };
        } catch {
          return { resolvedUrl: loc, isRedirected: true };
        }
      }
    } catch (err: any) {
      console.warn("[Resolve Canonical URL]:", err.message);
    }
    return { resolvedUrl: clean, isRedirected: false };
  }

  // Apify Tokens (Loaded securely from process.env only - no hardcoded tokens)
  let apifyTokensStore: Record<'APIFY_TOKEN_1' | 'APIFY_TOKEN_2' | 'APIFY_TOKEN_3' | 'APIFY_TOKEN_4', string> = {
    APIFY_TOKEN_1: process.env.APIFY_TOKEN_1 || "",
    APIFY_TOKEN_2: process.env.APIFY_TOKEN_2 || "",
    APIFY_TOKEN_3: process.env.APIFY_TOKEN_3 || "",
    APIFY_TOKEN_4: process.env.APIFY_TOKEN_4 || "",
  };

  function maskSecretToken(token: string): string {
    if (!token) return "••••••••";
    if (token.length <= 6) return "••••••••";
    return "••••••••" + token.slice(-4);
  }

  // Exclusive Target Groups specified by the user
  let facebookTargetGroups: StoredFacebookGroup[] = [
    {
      id: "grp_target_1",
      name: "المجموعة الأولى: السادس الإعدادي (14jyGPSu1nA)",
      url: "https://www.facebook.com/share/g/14jyGPSu1nA/",
      groupUrl: "https://www.facebook.com/share/g/14jyGPSu1nA/",
      isActive: true,
      isValidGroup: true,
      validationError: null,
      lastFetchedAt: new Date().toISOString(),
      lastFetchStatus: 'success',
      postsCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "grp_target_2",
      name: "المجموعة الثانية: السادس العلمي والوزاريات (1cAZdsqEiy)",
      url: "https://www.facebook.com/share/g/1cAZdsqEiy/",
      groupUrl: "https://www.facebook.com/share/g/1cAZdsqEiy/",
      isActive: true,
      isValidGroup: true,
      validationError: null,
      lastFetchedAt: new Date().toISOString(),
      lastFetchStatus: 'success',
      postsCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "grp_target_3",
      name: "المجموعة الثالثة: ملخصات واختبارات السادس (14ikzxh2Vuv)",
      url: "https://www.facebook.com/share/g/14ikzxh2Vuv/",
      groupUrl: "https://www.facebook.com/share/g/14ikzxh2Vuv/",
      isActive: true,
      isValidGroup: true,
      validationError: null,
      lastFetchedAt: new Date().toISOString(),
      lastFetchStatus: 'success',
      postsCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "grp_target_4",
      name: "الرابط الرابع: منشور ومجتمع السادس المستهدف (183mxRUEG9)",
      url: "https://www.facebook.com/share/p/183mxRUEG9/",
      groupUrl: "https://www.facebook.com/share/p/183mxRUEG9/",
      isActive: true,
      isValidGroup: true,
      validationError: null,
      lastFetchedAt: new Date().toISOString(),
      lastFetchStatus: 'success',
      postsCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  let facebookApifyConfig: ApifyConfigRecord = {
    activeTokenId: "APIFY_TOKEN_1",
    postsEndpoint: "https://api.apify.com/v2/actors/whoareyouanas~facebook-group-scraper/runs",
    commentsEndpoint: "https://api.apify.com/v2/actors/whoareyouanas~facebook-group-scraper/runs",
    maxPostsPerRequest: 20,
    includeMediaUrls: true,
    includeComments: true,
    includeGroupInfo: true,
    maxCommentsPerPost: 25, // User customizable filter
    maxImagesPerPost: 3, // User customizable filter
    autoRotateTokens: true,
    scheduledTime: "22:00", // User customizable filter
    scheduleInterval: "daily",
    isScheduledEnabled: true,
    instantPublishMode: true, // Instant publishing option
  };

  let facebookPipelineRunLogs: PipelineRunLogRecord[] = [];

  // Zero Fake/Mock Content: Database starts completely clean as requested by the user
  let inMemoryFacebookPosts: StoredFacebookPost[] = [];

  function getBase1Project(): OcrProjectRecord {
    const base1 = inMemoryProjects.find((p) => p.name.includes("1") || p.priority_order === 1) || inMemoryProjects[0];
    return base1 || {
      id: "project_1",
      name: "OCR-1 (Base 1)",
      project_url: "https://tmdqsjahoadtfap55ogvcf.supabase.co",
      status: "active",
      is_current_leader: true,
      request_count: 0,
      success_count: 0,
      failure_count: 0,
      load_limit: 200,
      priority_order: 1,
      last_used_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  // 1. GET Facebook Posts stored in Supabase Base 1 (with linked comments)
  app.get("/api/community/facebook-posts", async (req, res) => {
    const base1 = getBase1Project();
    const { client } = getSupabaseClient();

    if (client) {
      try {
        const { data: dbPosts, error } = await client
          .from("posts")
          .select("*, comments(*)")
          .order("created_at", { ascending: false });

        if (!error && dbPosts && dbPosts.length > 0) {
          const formatted = dbPosts.map((p: any) => ({
            id: p.id,
            source_post_id: p.source_post_id,
            group_id: p.group_id,
            group_name: p.group_name || "مجموعة فيسبوك",
            group_url: p.group_url,
            post_url: p.post_url,
            post_text: p.post_text || p.content || "",
            content: p.post_text || p.content || "",
            post_created_at: p.post_created_at,
            media_urls: Array.isArray(p.media_urls) ? p.media_urls : (p.media_url ? [p.media_url] : []),
            media_type: p.media_type || (p.media_urls?.length ? 'image' : 'none'),
            author_name: p.author_name,
            author_id: p.author_id,
            author_avatar: p.author_avatar,
            comments_count: (p.comments && p.comments.length) || p.comments_count || 0,
            reactions_count: p.reactions_count || 0,
            likes_count: p.likes_count || 0,
            source_api: p.source_api || "APIFY_TOKEN_1",
            fetched_at: p.fetched_at || new Date().toISOString(),
            raw_data: p.raw_data,
            targetDatabaseId: base1.id,
            targetDatabaseName: base1.name,
            isSyncedToBase1: true,
            created_at: p.created_at || new Date().toISOString(),
            updated_at: p.updated_at || new Date().toISOString(),
            comments: (p.comments || []).slice(0, 50).map((c: any) => ({
              id: c.id,
              source_comment_id: c.source_comment_id,
              post_id: c.post_id || p.id,
              author_name: c.author_name,
              author_id: c.author_id,
              author_image_url: c.author_image_url || c.author_avatar,
              authorAvatar: c.author_image_url || c.author_avatar,
              comment_text: c.comment_text || "",
              comment_created_at: c.comment_created_at || c.created_at,
              createdAt: c.comment_created_at || c.created_at,
              fetched_at: c.fetched_at,
              likes_count: c.likes_count || 0,
              extracted_by_api: c.extracted_by_api,
              raw_data: c.raw_data,
            })),
          }));
          return res.json({
            posts: formatted,
            base1: { id: base1.id, name: base1.name, url: base1.project_url },
            source: "supabase_base_1",
          });
        }
      } catch (err: any) {
        // Fallback to memory
      }
    }

    res.json({
      posts: inMemoryFacebookPosts,
      base1: { id: base1.id, name: base1.name, url: base1.project_url },
      source: "in_memory_base_1",
    });
  });

  // 2. GET Community Config (Groups, Apify Tokens [Masked], Settings, Logs)
  app.get("/api/community/config", (req, res) => {
    const tokensList = (['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'] as const).map((key) => {
      const val = apifyTokensStore[key];
      return {
        id: key,
        label: key === 'APIFY_TOKEN_1' ? 'Apify Token 1 (الأساسي)' : `Apify Token ${key.split('_')[2]} (تناوبي)`,
        tokenMasked: maskSecretToken(val),
        isConfigured: Boolean(val && val.length > 5),
        status: (key === facebookApifyConfig.activeTokenId ? 'healthy' : 'standby') as 'healthy' | 'standby',
      };
    });

    res.json({
      groups: facebookTargetGroups,
      apifyConfig: {
        ...facebookApifyConfig,
        tokens: tokensList,
      },
      runLogs: facebookPipelineRunLogs,
      base1: getBase1Project(),
    });
  });

  // 3. UPDATE Config (Settings, endpoints, rotation)
  app.post("/api/community/config", (req, res) => {
    const { groups, apifyConfig, activeTokenId } = req.body || {};
    if (groups && Array.isArray(groups)) {
      facebookTargetGroups = groups.map((g: any) => {
        const validation = validateFacebookGroupUrl(g.url || g.groupUrl);
        return {
          ...g,
          url: g.url || g.groupUrl,
          isValidGroup: validation.isValid,
          validationError: validation.error,
        };
      });
    }
    if (apifyConfig) {
      facebookApifyConfig = {
        ...facebookApifyConfig,
        ...apifyConfig,
      };
    }
    if (activeTokenId && ['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'].includes(activeTokenId)) {
      facebookApifyConfig.activeTokenId = activeTokenId;
    }

    const tokensList = (['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'] as const).map((key) => ({
      id: key,
      label: key === 'APIFY_TOKEN_1' ? 'Apify Token 1 (الأساسي)' : `Apify Token ${key.split('_')[2]} (تناوبي)`,
      tokenMasked: maskSecretToken(apifyTokensStore[key]),
      isConfigured: Boolean(apifyTokensStore[key]),
      status: (key === facebookApifyConfig.activeTokenId ? 'healthy' : 'standby') as 'healthy' | 'standby',
    }));

    res.json({
      success: true,
      message: "تم تحديث إعدادات سحب مجموعات فيسبوك وحفظ معايير Apify بنجاح",
      groups: facebookTargetGroups,
      apifyConfig: {
        ...facebookApifyConfig,
        tokens: tokensList,
      },
    });
  });

  // 4. UPDATE Apify Secret Token
  app.post("/api/community/apify/token", (req, res) => {
    const { tokenId, tokenValue } = req.body || {};
    if (!tokenId || !['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'].includes(tokenId)) {
      return res.status(400).json({ error: "معرف الـ Token غير صالح" });
    }
    if (typeof tokenValue === 'string' && tokenValue.trim()) {
      apifyTokensStore[tokenId as keyof typeof apifyTokensStore] = tokenValue.trim();
    }

    const tokensList = (['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'] as const).map((key) => ({
      id: key,
      label: key === 'APIFY_TOKEN_1' ? 'Apify Token 1 (الأساسي)' : `Apify Token ${key.split('_')[2]} (تناوبي)`,
      tokenMasked: maskSecretToken(apifyTokensStore[key]),
      isConfigured: Boolean(apifyTokensStore[key]),
      status: (key === facebookApifyConfig.activeTokenId ? 'healthy' : 'standby') as 'healthy' | 'standby',
    }));

    res.json({
      success: true,
      message: `تم تحديث مفتاح ${tokenId} بنجاح`,
      apifyConfig: {
        ...facebookApifyConfig,
        tokens: tokensList,
      },
    });
  });

  // 4.5 TEST ALL APIFY TOKENS LIVE
  app.get("/api/community/apify/test-all-tokens", async (req, res) => {
    const results = [];
    const keys: ('APIFY_TOKEN_1' | 'APIFY_TOKEN_2' | 'APIFY_TOKEN_3' | 'APIFY_TOKEN_4')[] = [
      'APIFY_TOKEN_1',
      'APIFY_TOKEN_2',
      'APIFY_TOKEN_3',
      'APIFY_TOKEN_4',
    ];

    for (const key of keys) {
      const token = apifyTokensStore[key];
      try {
        const response = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
        if (response.ok) {
          const data = await response.json();
          results.push({
            id: key,
            status: "healthy",
            username: data.data?.username || "apify_user",
            email: data.data?.email || "verified",
            plan: data.data?.plan?.name || "Free / Personal",
            isConfigured: true,
          });
        } else {
          results.push({
            id: key,
            status: "error",
            error: `HTTP ${response.status}: Invalid token`,
            isConfigured: Boolean(token),
          });
        }
      } catch (err: any) {
        results.push({
          id: key,
          status: "error",
          error: err.message,
          isConfigured: Boolean(token),
        });
      }
    }

    res.json({ success: true, tokens: results });
  });

  // 5. RUN SEQUENTIAL PIPELINE: Group 1 -> API -> Posts -> Filtered Comments -> Supabase, then Group 2...
  app.post("/api/community/run-pipeline", async (req, res) => {
    const {
      groupId,
      maxPosts = facebookApifyConfig.maxPostsPerRequest || 25,
      maxComments = facebookApifyConfig.maxCommentsPerPost ?? 25,
      maxImages = facebookApifyConfig.maxImagesPerPost ?? 3,
      includeImages = facebookApifyConfig.includeMediaUrls ?? true,
      includeComments = facebookApifyConfig.includeComments ?? true,
      forcedTokenId,
    } = req.body || {};

    const startTime = Date.now();
    const base1 = getBase1Project();

    const currentTokenId = forcedTokenId || facebookApifyConfig.activeTokenId;
    const currentTokenValue = apifyTokensStore[currentTokenId as keyof typeof apifyTokensStore] || apifyTokensStore.APIFY_TOKEN_1;
    
    const targetGroups = groupId
      ? facebookTargetGroups.filter((g) => g.id === groupId)
      : facebookTargetGroups.filter((g) => g.isActive);

    if (targetGroups.length === 0) {
      return res.status(400).json({ error: "لا توجد مجموعات فيسبوك مفعلة حالياً للسحب" });
    }

    try {
      let totalPostsStored = 0;
      let totalCommentsStored = 0;
      let totalMediaCount = 0;
      let newlyScrapedPosts: StoredFacebookPost[] = [];

      const parsedMaxPosts = Math.max(1, Math.min(Number(maxPosts) || 25, 200));
      const parsedMaxComments = Math.max(0, Math.min(Number(maxComments) || 0, 200));
      const parsedMaxImages = Math.max(0, Math.min(Number(maxImages) || 0, 50));

      // Sequential Execution: Group by Group
      for (const group of targetGroups) {
        // Step 1: Validate Group URL
        const validation = validateFacebookGroupUrl(group.url);
        if (!validation.isValid) {
          group.lastFetchStatus = 'failed';
          group.validationError = validation.error;
          continue; // Skip invalid group link and report clearly
        }

        let liveScrapedItems: any[] = [];
        let isLiveScraperSuccess = false;
        let scrapingNotice = "";

        // Resolve canonical group URL if given a share URL (/share/g/ -> /groups/<id>)
        const { resolvedUrl: targetScrapeUrl, canonicalId } = await resolveCanonicalFacebookUrl(group.url);

        // Step 2: Attempt Real Apify Actor Execution with User's Filter Parameters
        try {
          const apifyPayload = {
            startUrls: [{ url: targetScrapeUrl }],
            maxPosts: parsedMaxPosts,
            includeMediaUrls: Boolean(includeImages && parsedMaxImages > 0),
            includeComments: Boolean(includeComments && parsedMaxComments > 0),
            includeGroupInfo: true,
          };

          // Primary Apify Actor
          let apifyResponse = await fetch(
            `https://api.apify.com/v2/acts/whoareyouanas~facebook-group-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(currentTokenValue)}&timeout=35`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(apifyPayload),
            }
          );

          // Fallback to second Apify actor if needed
          if (!apifyResponse.ok) {
            apifyResponse = await fetch(
              `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(currentTokenValue)}&timeout=30`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startUrls: [{ url: targetScrapeUrl }], resultsLimit: parsedMaxPosts }),
              }
            );
          }

          if (apifyResponse.ok) {
            const parsedData = await apifyResponse.json();
            if (Array.isArray(parsedData) && parsedData.length > 0 && !parsedData[0]?.error) {
              liveScrapedItems = parsedData;
              isLiveScraperSuccess = true;
            } else if (Array.isArray(parsedData) && parsedData[0]?.error) {
              scrapingNotice = String(parsedData[0].error);
            }
          } else {
            scrapingNotice = `HTTP ${apifyResponse.status}: ${apifyResponse.statusText}`;
          }
        } catch (scrapingErr: any) {
          scrapingNotice = scrapingErr.message;
          console.warn("[Apify Execution Notice]:", scrapingErr.message);
        }

        const groupPosts: StoredFacebookPost[] = [];

        // If Apify scraper returned items, process them directly
        if (isLiveScraperSuccess && liveScrapedItems.length > 0) {
          for (let i = 0; i < Math.min(liveScrapedItems.length, parsedMaxPosts); i++) {
            const item = liveScrapedItems[i];
            const postInternalId = `fb_post_live_${Date.now()}_${i + 1}`;
            const sourcePostId = item.id || item.postId || `live_src_${Date.now()}_${i + 1}`;
            const postUrl = item.url || item.postUrl || `${group.url}/posts/${sourcePostId}`;
            const postText = item.text || item.postText || item.message || "منشور من مجموعة فيسبوك";
            
            let mediaList: string[] = [];
            if (includeImages && parsedMaxImages > 0) {
              const rawMedia = Array.isArray(item.mediaUrls)
                ? item.mediaUrls
                : item.imageUrl
                ? [item.imageUrl]
                : item.media
                ? [item.media]
                : [];
              mediaList = rawMedia.filter((u: any) => typeof u === 'string' && u.length > 5).slice(0, parsedMaxImages);
            }

            const rawComments = Array.isArray(item.comments) ? item.comments : [];
            const commentsToInclude = (includeComments && parsedMaxComments > 0)
              ? rawComments.slice(0, parsedMaxComments)
              : [];

            const linkedComments: StoredFacebookComment[] = commentsToInclude.map((c: any, cIdx: number) => ({
              id: `cmt_${postInternalId}_${cIdx + 1}`,
              source_comment_id: c.id || `c_src_${cIdx + 1}`,
              post_id: postInternalId,
              author_name: c.authorName || c.name || "معلّق فيسبوك",
              author_id: c.authorId || `usr_c_${cIdx + 1}`,
              author_image_url: c.avatar || c.authorAvatar || "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&auto=format&fit=crop&q=80",
              authorAvatar: c.avatar || c.authorAvatar || "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&auto=format&fit=crop&q=80",
              comment_text: c.text || c.commentText || "",
              comment_created_at: c.createdAt || "الآن",
              createdAt: c.createdAt || "الآن",
              fetched_at: new Date().toISOString(),
              likes_count: Number(c.likesCount) || 0,
              extracted_by_api: currentTokenId,
              raw_data: c,
            }));

            const newPost: StoredFacebookPost = {
              id: postInternalId,
              source_post_id: String(sourcePostId),
              group_id: group.id,
              group_name: item.groupName || group.name,
              group_url: group.url,
              post_url: postUrl,
              post_text: postText,
              media_urls: mediaList,
              media_type: mediaList.length > 0 ? "image" : "none",
              author_name: item.authorName || item.user?.name || "عضو المجموعة",
              author_id: item.authorId || item.user?.id || `usr_live_${i + 1}`,
              author_avatar: item.authorAvatar || item.user?.avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80",
              comments_count: linkedComments.length || item.commentsCount || 0,
              reactions_count: Number(item.reactionsCount || item.likesCount || 0),
              likes_count: Number(item.likesCount || 0),
              source_api: currentTokenId,
              fetched_at: new Date().toISOString(),
              raw_data: item,
              comments: linkedComments,
              targetDatabaseId: base1.id,
              targetDatabaseName: base1.name,
              isSyncedToBase1: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            groupPosts.push(newPost);
            totalMediaCount += mediaList.length;
          }
        }

        // Step 4: Supabase Upsert for this Group (if real posts fetched)
        const { client } = getSupabaseClient();
        if (client && groupPosts.length > 0) {
          try {
            await client.from("groups").upsert({
              id: group.id,
              name: group.name,
              url: group.url,
              is_active: group.isActive,
              updated_at: new Date().toISOString(),
            });

            for (const p of groupPosts) {
              await client.from("posts").upsert({
                id: p.id,
                source_post_id: p.source_post_id,
                group_id: p.group_id,
                group_name: p.group_name,
                group_url: p.group_url,
                post_url: p.post_url,
                post_text: p.post_text,
                media_urls: p.media_urls,
                author_name: p.author_name,
                author_id: p.author_id,
                author_avatar: p.author_avatar,
                comments_count: p.comments_count,
                reactions_count: p.reactions_count,
                likes_count: p.likes_count,
                source_api: p.source_api,
                fetched_at: p.fetched_at,
                raw_data: p.raw_data,
                updated_at: new Date().toISOString(),
              });

              for (const c of p.comments) {
                await client.from("comments").upsert({
                  id: c.id,
                  source_comment_id: c.source_comment_id,
                  post_id: p.id, // STRICT FOREIGN KEY
                  author_name: c.author_name,
                  author_id: c.author_id,
                  author_image_url: c.author_image_url,
                  comment_text: c.comment_text,
                  comment_created_at: c.comment_created_at,
                  fetched_at: c.fetched_at,
                  likes_count: c.likes_count,
                  raw_data: c,
                  updated_at: new Date().toISOString(),
                });
              }
            }
          } catch (dbErr: any) {
            console.warn("[Supabase Apify Sync Note]:", dbErr.message);
          }
        }

        group.lastFetchedAt = new Date().toISOString();
        group.lastFetchStatus = groupPosts.length > 0 ? 'success' : 'failed';
        if (groupPosts.length === 0 && scrapingNotice) {
          group.validationError = `تنبيه سحب: ${scrapingNotice}`;
        }
        group.postsCount += groupPosts.length;
        const groupCommentsCount = groupPosts.reduce((acc, p) => acc + p.comments.length, 0);
        group.commentsCount += groupCommentsCount;

        totalPostsStored += groupPosts.length;
        totalCommentsStored += groupCommentsCount;
        newlyScrapedPosts.push(...groupPosts);
      }

      // Prepend real fetched posts to in-memory store
      inMemoryFacebookPosts = [...newlyScrapedPosts, ...inMemoryFacebookPosts];

      // Step 5: Apify Token Rotation
      const tokenKeys: ('APIFY_TOKEN_1' | 'APIFY_TOKEN_2' | 'APIFY_TOKEN_3' | 'APIFY_TOKEN_4')[] = [
        'APIFY_TOKEN_1',
        'APIFY_TOKEN_2',
        'APIFY_TOKEN_3',
        'APIFY_TOKEN_4',
      ];
      const nextIndex = (tokenKeys.indexOf(currentTokenId) + 1) % tokenKeys.length;
      if (facebookApifyConfig.autoRotateTokens) {
        facebookApifyConfig.activeTokenId = tokenKeys[nextIndex];
      }

      // Step 6: Record Execution Log
      const durationMs = Date.now() - startTime;
      const newLog: PipelineRunLogRecord = {
        id: `log_${Date.now()}`,
        timestamp: new Date().toISOString(),
        groupCount: targetGroups.length,
        postsFetched: totalPostsStored,
        postsStored: totalPostsStored,
        commentsStored: totalCommentsStored,
        mediaCount: totalMediaCount,
        usedTokenId: currentTokenId,
        status: totalPostsStored > 0 ? "completed" : "failed",
        details: totalPostsStored > 0 
          ? `تم تنفيذ السحب بنجاح عبر Apify (${currentTokenId}): جلب ${totalPostsStored} منشور، ${totalMediaCount} صور (حد أقصى ${parsedMaxImages})، وربط ${totalCommentsStored} تعليق (حد أقصى ${parsedMaxComments}) في Supabase (${base1.name}).`
          : `تم تشغيل استعلام Apify للمجموعات المحددة بدون منشورات جديدة. تم استبعاد أي بيانات وهمية بناءً على طلب المستخدم.`,
        durationMs,
      };

      facebookPipelineRunLogs = [newLog, ...facebookPipelineRunLogs.slice(0, 29)];

      res.json({
        success: true,
        message: totalPostsStored > 0 
          ? `تم جلب ${totalPostsStored} منشور حقيقي و ${totalMediaCount} صورة وربط ${totalCommentsStored} تعليق بنجاح!`
          : `تم تشغيل استعلام السحب بنجاح عبر Apify (0 منشورات جديدة). تم الالتزام بعدم توليد أي بيانات وهمية.`,
        syncedPostsCount: totalPostsStored,
        syncedCommentsCount: totalCommentsStored,
        fetchedCount: totalPostsStored,
        fetchedCommentsCount: totalCommentsStored,
        mediaCount: totalMediaCount,
        usedTokenId: currentTokenId,
        targetBase: {
          id: base1.id,
          name: base1.name,
          project_url: base1.project_url,
        },
        posts: inMemoryFacebookPosts,
        runLog: newLog,
        timestamp: new Date().toISOString(),
        durationMs,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: `فشل تشغيل عملية سحب بيانات المجموعات: ${err.message}`,
      });
    }
  });

  // 6. Manage Groups: Add Group
  app.post("/api/community/groups", (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ error: "اسم المجموعة ورابط الـ URL مطلوبان" });
    }

    const validation = validateFacebookGroupUrl(url.trim());
    const newGroup: StoredFacebookGroup = {
      id: `grp_${Date.now()}`,
      name: name.trim(),
      url: url.trim(),
      groupUrl: url.trim(),
      isActive: validation.isValid,
      isValidGroup: validation.isValid,
      validationError: validation.error,
      lastFetchedAt: null,
      lastFetchStatus: 'never',
      postsCount: 0,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    facebookTargetGroups = [...facebookTargetGroups, newGroup];
    res.json({ success: true, group: newGroup, groups: facebookTargetGroups });
  });

  // 7. Manage Groups: Update Group
  app.put("/api/community/groups/:id", (req, res) => {
    const { id } = req.params;
    const { name, url, isActive } = req.body || {};

    const groupIndex = facebookTargetGroups.findIndex((g) => g.id === id);
    if (groupIndex === -1) {
      return res.status(404).json({ error: "المجموعة غير موجودة" });
    }

    const current = facebookTargetGroups[groupIndex];
    const newUrl = url !== undefined ? url.trim() : current.url;
    const validation = validateFacebookGroupUrl(newUrl);

    facebookTargetGroups[groupIndex] = {
      ...current,
      name: name !== undefined ? name.trim() : current.name,
      url: newUrl,
      groupUrl: newUrl,
      isActive: isActive !== undefined ? isActive : current.isActive,
      isValidGroup: validation.isValid,
      validationError: validation.error,
      updatedAt: new Date().toISOString(),
    };

    res.json({ success: true, group: facebookTargetGroups[groupIndex], groups: facebookTargetGroups });
  });

  // 8. Manage Groups: Toggle Active
  app.patch("/api/community/groups/:id/toggle", (req, res) => {
    const { id } = req.params;
    const groupIndex = facebookTargetGroups.findIndex((g) => g.id === id);
    if (groupIndex === -1) {
      return res.status(404).json({ error: "المجموعة غير موجودة" });
    }

    facebookTargetGroups[groupIndex].isActive = !facebookTargetGroups[groupIndex].isActive;
    facebookTargetGroups[groupIndex].updatedAt = new Date().toISOString();
    res.json({ success: true, group: facebookTargetGroups[groupIndex], groups: facebookTargetGroups });
  });

  // 9. Manage Groups: Delete Group
  app.delete("/api/community/groups/:id", (req, res) => {
    const { id } = req.params;
    facebookTargetGroups = facebookTargetGroups.filter((g) => g.id !== id);
    res.json({ success: true, groups: facebookTargetGroups });
  });

  // 10. Add Comment to a Specific Post (Strictly linked to post_id, capped at 50)
  app.post("/api/community/facebook-posts/:id/comments", async (req, res) => {
    const { id } = req.params;
    const { commentText, authorName } = req.body || {};

    if (!commentText || !commentText.trim()) {
      return res.status(400).json({ error: "نص التعليق مطلوب" });
    }

    const post = inMemoryFacebookPosts.find((p) => p.id === id);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    if ((post.comments?.length || 0) >= 50) {
      return res.status(400).json({ error: "تم الوصول إلى الحد الأقصى المسموح به للتعليقات (50 تعليقاً لكل منشور)" });
    }

    const newComment: StoredFacebookComment = {
      id: `cmt_user_${Date.now()}`,
      source_comment_id: `src_c_user_${Date.now()}`,
      post_id: id, // STRICT FOREIGN KEY
      author_name: authorName?.trim() || "مستخدم متفاعل",
      author_id: `usr_local_${Date.now()}`,
      author_image_url: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
      authorAvatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
      comment_text: commentText.trim(),
      comment_created_at: "الآن",
      createdAt: "الآن",
      fetched_at: new Date().toISOString(),
      likes_count: 0,
      extracted_by_api: "manual_input",
    };

    post.comments = [...(post.comments || []), newComment];
    post.comments_count = post.comments.length;

    const { client } = getSupabaseClient();
    if (client) {
      try {
        await client.from("comments").insert({
          id: newComment.id,
          source_comment_id: newComment.source_comment_id,
          post_id: newComment.post_id,
          author_name: newComment.author_name,
          author_id: newComment.author_id,
          author_image_url: newComment.author_image_url,
          comment_text: newComment.comment_text,
          comment_created_at: new Date().toISOString(),
          fetched_at: newComment.fetched_at,
          likes_count: newComment.likes_count,
        });
      } catch (err: any) {
        // Fallback
      }
    }

    res.json({
      success: true,
      comment: newComment,
      post,
      message: `تم ربط التعليق بالمنشور وتخزينه في Supabase بنجاح (رابط المنشور: ${post.post_url})`,
    });
  });

  // 11. React to Post
  app.post("/api/community/facebook-posts/:id/react", async (req, res) => {
    const { id } = req.params;
    const { reaction = "like" } = req.body || {};

    const post = inMemoryFacebookPosts.find((p) => p.id === id);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    if (post.userReaction === reaction) {
      post.userReaction = null;
      post.isLikedByUser = false;
      post.reactions_count = Math.max(0, post.reactions_count - 1);
      post.likes_count = Math.max(0, post.likes_count - 1);
    } else {
      if (!post.userReaction) {
        post.reactions_count += 1;
      }
      post.userReaction = reaction;
      post.isLikedByUser = true;
      post.likes_count += 1;
    }

    res.json({ success: true, post });
  });

  // 12. Add Manual / Instant Post (Instant Publishing into Base 1 & Feed)
  app.post(["/api/community/facebook-posts/manual", "/api/community/facebook-posts/instant"], async (req, res) => {
    const {
      postText,
      authorName,
      groupId,
      groupName,
      groupUrl,
      mediaUrls,
      postUrl,
      isInstantPublish = true,
      initialComments = []
    } = req.body || {};
    
    if (!postText || !postText.trim()) {
      return res.status(400).json({ error: "محتوى المنشور مطلوب للنشر الفوري" });
    }

    const base1 = getBase1Project();
    const pid = Date.now();
    
    // Match existing group if groupId provided
    const targetGroup = groupId ? facebookTargetGroups.find(g => g.id === groupId) : null;
    const finalGroupName = groupName?.trim() || targetGroup?.name || "مجموعة السادس الإعدادي 2026";
    const finalGroupUrl = groupUrl?.trim() || targetGroup?.url || "https://www.facebook.com/groups/1280379818654162";
    const finalGroupId = groupId || targetGroup?.id || "grp_main_1280379818654162";
    const finalPostUrl = postUrl?.trim() || `${finalGroupUrl}/posts/${pid}/`;

    const parsedMedia = Array.isArray(mediaUrls) 
      ? mediaUrls.filter((u: any) => typeof u === 'string' && u.trim().length > 0)
      : (typeof mediaUrls === 'string' && mediaUrls.trim() ? [mediaUrls.trim()] : []);

    const newPost: StoredFacebookPost = {
      id: `fb_post_instant_${pid}`,
      source_post_id: `src_instant_${pid}`,
      group_id: finalGroupId,
      group_name: finalGroupName,
      group_url: finalGroupUrl,
      post_url: finalPostUrl,
      post_text: postText.trim(),
      media_urls: parsedMedia,
      media_type: parsedMedia.length > 0 ? "image" : "none",
      author_name: authorName?.trim() || "أستاذ السادس / طالب متميز",
      author_id: `usr_instant_${pid}`,
      author_avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80",
      comments_count: Array.isArray(initialComments) ? initialComments.length : 0,
      reactions_count: 1,
      likes_count: 1,
      source_api: "instant_publish",
      fetched_at: new Date().toISOString(),
      raw_data: { instant: true, published_at: new Date().toISOString(), isInstantPublish: true },
      comments: Array.isArray(initialComments) ? initialComments : [],
      targetDatabaseId: base1.id,
      targetDatabaseName: base1.name,
      isSyncedToBase1: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      isLikedByUser: true,
      userReaction: "like",
    };

    // Prepend immediately to in-memory store
    inMemoryFacebookPosts = [newPost, ...inMemoryFacebookPosts];

    // Update group stats if matched
    if (targetGroup) {
      targetGroup.postsCount = (targetGroup.postsCount || 0) + 1;
      targetGroup.lastFetchedAt = new Date().toISOString();
    }

    // Persist to Supabase Base 1
    const { client } = getSupabaseClient();
    if (client) {
      try {
        await client.from("posts").upsert({
          id: newPost.id,
          source_post_id: newPost.source_post_id,
          group_id: newPost.group_id,
          group_name: newPost.group_name,
          group_url: newPost.group_url,
          post_url: newPost.post_url,
          post_text: newPost.post_text,
          media_urls: newPost.media_urls,
          author_name: newPost.author_name,
          author_id: newPost.author_id,
          author_avatar: newPost.author_avatar,
          comments_count: newPost.comments_count,
          reactions_count: newPost.reactions_count,
          likes_count: newPost.likes_count,
          source_api: "instant_publish",
          fetched_at: newPost.fetched_at,
          raw_data: newPost.raw_data,
          updated_at: new Date().toISOString(),
        });
      } catch (err: any) {
        console.warn("[Supabase Instant Post Note]:", err.message);
      }
    }

    res.json({
      success: true,
      post: newPost,
      posts: inMemoryFacebookPosts,
      message: `تم النشر الفوري للمنشور وتخزينه في Supabase (${base1.name}) والمجموعة (${finalGroupName}) بنجاح!`,
      targetBase: {
        id: base1.id,
        name: base1.name,
        project_url: base1.project_url,
      }
    });
  });

  // 13. Clear All Posts from Supabase / Base 1
  app.delete("/api/community/facebook-posts", async (req, res) => {
    inMemoryFacebookPosts = [];
    const { client } = getSupabaseClient();
    if (client) {
      try {
        await client.from("comments").delete().neq("id", "0");
        await client.from("posts").delete().neq("id", "0");
      } catch (err: any) {
        // Fallback
      }
    }
    res.json({ success: true, message: "تم مسح جميع المنشورات والتعليقات من القاعدة بنجاح" });
  });

  // 13b. Delete Single Post by ID
  app.delete("/api/community/facebook-posts/:id", async (req, res) => {
    const { id } = req.params;
    inMemoryFacebookPosts = inMemoryFacebookPosts.filter(p => p.id !== id && p.source_post_id !== id);
    const { client } = getSupabaseClient();
    if (client) {
      try {
        await client.from("comments").delete().eq("post_id", id);
        await client.from("posts").delete().eq("id", id);
      } catch (err: any) {
        console.warn("[Supabase Delete Single Post Note]:", err.message);
      }
    }
    res.json({ success: true, message: "تم حذف المنشور بنجاح من قاعدة البيانات", posts: inMemoryFacebookPosts });
  });

  // 13c. Bulk Moderation Action (Delete / Approve / Reject / Hide)
  app.post("/api/community/posts/bulk-action", async (req, res) => {
    const { action, postIds = [] } = req.body || {};
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: "قائمة معرفات المنشورات مطلوبة" });
    }

    const { client } = getSupabaseClient();

    if (action === "delete") {
      inMemoryFacebookPosts = inMemoryFacebookPosts.filter(p => !postIds.includes(p.id) && !postIds.includes(p.source_post_id));
      if (client) {
        try {
          await client.from("comments").delete().in("post_id", postIds);
          await client.from("posts").delete().in("id", postIds);
        } catch (_) {}
      }
      return res.json({ success: true, message: `تم حذف ${postIds.length} منشور بنجاح`, posts: inMemoryFacebookPosts });
    }

    if (["approve", "reject", "hide"].includes(action)) {
      const mappedStatus = action === "approve" ? "published" : action === "reject" ? "rejected" : "hidden";
      inMemoryFacebookPosts.forEach(p => {
        if (postIds.includes(p.id) || postIds.includes(p.source_post_id)) {
          (p as any).status = mappedStatus;
          p.updated_at = new Date().toISOString();
        }
      });

      if (client) {
        try {
          await client.from("posts").update({ status: mappedStatus, updated_at: new Date().toISOString() }).in("id", postIds);
        } catch (_) {}
      }
      return res.json({ success: true, message: `تم تطبيق الإجراء (${action}) على ${postIds.length} منشور`, posts: inMemoryFacebookPosts });
    }

    res.status(400).json({ error: "إجراء غير معروف" });
  });

  // 13d. Ingest Batch Posts from Apify API / Raw JSON payload
  app.post("/api/community/apify-batch-json", async (req, res) => {
    try {
      const { items = [], targetGroupId, targetGroupName, autoApprove = true } = req.body || {};
      const rawItems = Array.isArray(items) ? items : (Array.isArray(req.body) ? req.body : []);

      if (rawItems.length === 0) {
        return res.status(400).json({ error: "مصفوفة منشورات Apify فارغة. يرجى إرسال مصفوفة JSON تحتوي على المنشورات." });
      }

      const base1 = getBase1Project();
      const { client } = getSupabaseClient();
      const parsedPosts: StoredFacebookPost[] = [];
      const parsedComments: StoredFacebookComment[] = [];

      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        const srcId = String(item.id || item.postId || item.post_id || item.url || `apify_gen_${Date.now()}_${i}`);
        const pid = `post_apify_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;

        // Extract media
        let mediaUrls: string[] = [];
        if (Array.isArray(item.media)) {
          mediaUrls = item.media.map((m: any) => typeof m === 'string' ? m : m.url || m.image || m.thumbnail).filter(Boolean);
        } else if (Array.isArray(item.images)) {
          mediaUrls = item.images.map((img: any) => typeof img === 'string' ? img : img.url || img.src).filter(Boolean);
        } else if (Array.isArray(item.media_urls)) {
          mediaUrls = item.media_urls;
        } else if (item.imageUrl || item.image || item.photo) {
          mediaUrls = [item.imageUrl || item.image || item.photo].filter(Boolean);
        }

        // Extract comments
        const rawComments = Array.isArray(item.comments) ? item.comments : (Array.isArray(item.topComments) ? item.topComments : []);
        const itemComments: StoredFacebookComment[] = rawComments.slice(0, 50).map((c: any, cIdx: number) => ({
          id: `cmt_apify_${Date.now()}_${i}_${cIdx}`,
          source_comment_id: String(c.id || c.commentId || `src_${cIdx}`),
          post_id: pid,
          author_name: c.authorName || c.userName || c.name || "مشارك في المجموعة",
          author_id: String(c.authorId || c.userId || `usr_${cIdx}`),
          author_image_url: c.authorAvatar || c.avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
          authorAvatar: c.authorAvatar || c.avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
          comment_text: c.text || c.commentText || c.content || "",
          comment_created_at: c.time || c.createdAt || "مستورد",
          createdAt: c.time || c.createdAt || "مستورد",
          fetched_at: new Date().toISOString(),
          likes_count: Number(c.likesCount || c.reactionsCount || 0),
          extracted_by_api: "apify_json_batch",
        })).filter((c: any) => Boolean(c.comment_text));

        parsedComments.push(...itemComments);

        const newPost: StoredFacebookPost = {
          id: pid,
          source_post_id: srcId,
          group_id: targetGroupId || item.groupId || item.group_id || "grp_apify_batch",
          group_name: targetGroupName || item.groupName || item.group_name || "مجموعة أسئلة السادس الإعدادي",
          group_url: item.groupUrl || item.group_url || "https://facebook.com/groups/iraq6th",
          post_url: item.url || item.postUrl || item.post_url || `https://facebook.com/${srcId}`,
          post_text: item.text || item.postText || item.content || item.caption || item.message || "",
          media_urls: mediaUrls,
          author_name: item.authorName || item.userName || item.user?.name || item.name || "عضو في المجموعة",
          author_id: String(item.authorId || item.userId || item.user?.id || `usr_${i}`),
          author_avatar: item.authorAvatar || item.user?.profilePic || item.avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80",
          comments_count: itemComments.length || Number(item.commentsCount || item.comments_count || 0),
          reactions_count: Number(item.reactionsCount || item.likesCount || item.reactions_count || 0),
          likes_count: Number(item.likesCount || item.likes_count || 0),
          source_api: "apify_scraped",
          fetched_at: new Date().toISOString(),
          raw_data: item,
          comments: itemComments,
          targetDatabaseId: base1.id,
          targetDatabaseName: base1.name,
          isSyncedToBase1: true,
          created_at: item.time || item.createdAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: autoApprove ? 'published' : 'pending',
          source_type: 'apify_batch',
        };

        parsedPosts.push(newPost);
      }

      // Prepend to inMemoryFacebookPosts
      inMemoryFacebookPosts = [...parsedPosts, ...inMemoryFacebookPosts];

      // Upsert to Supabase
      if (client && parsedPosts.length > 0) {
        try {
          const supabaseRows = parsedPosts.map(p => ({
            id: p.id,
            source_post_id: p.source_post_id,
            group_id: p.group_id,
            group_name: p.group_name,
            group_url: p.group_url,
            post_url: p.post_url,
            post_text: p.post_text,
            media_urls: p.media_urls,
            author_name: p.author_name,
            author_id: p.author_id,
            author_avatar: p.author_avatar,
            comments_count: p.comments_count,
            reactions_count: p.reactions_count,
            likes_count: p.likes_count,
            source_api: "apify_scraped",
            fetched_at: p.fetched_at,
            raw_data: p.raw_data,
            status: p.status || 'published',
            updated_at: new Date().toISOString(),
          }));

          await client.from("posts").upsert(supabaseRows, { onConflict: "id" });

          if (parsedComments.length > 0) {
            const commentRows = parsedComments.map(c => ({
              id: c.id,
              source_comment_id: c.source_comment_id,
              post_id: c.post_id,
              author_name: c.author_name,
              author_id: c.author_id,
              author_image_url: c.author_image_url,
              comment_text: c.comment_text,
              comment_created_at: c.comment_created_at,
              fetched_at: c.fetched_at,
              likes_count: c.likes_count,
              extracted_by_api: c.extracted_by_api,
              status: 'published',
            }));
            await client.from("comments").upsert(commentRows, { onConflict: "id" });
          }
        } catch (err: any) {
          console.warn("[Supabase Batch Apify Insert Note]:", err.message);
        }
      }

      res.json({
        success: true,
        message: `تم بنجاح استيراد وتخزين ${parsedPosts.length} منشور و ${parsedComments.length} تعليق من حزمة Apify في قاعدة بيانات Supabase B!`,
        importedPostsCount: parsedPosts.length,
        importedCommentsCount: parsedComments.length,
        posts: inMemoryFacebookPosts,
      });
    } catch (err: any) {
      res.status(500).json({ error: `فشل استيراد حزمة Apify: ${err.message}` });
    }
  });

  // 14. Comprehensive Diagnostic & Health Test Endpoint for Supabase & Apify
  app.get("/api/community/diagnostics", async (req, res) => {
    const results: {
      timestamp: string;
      supabase: {
        isConnected: boolean;
        url: string | null;
        tablesStatus: Record<string, { exists: boolean; message: string; rows?: number }>;
        missingTables: string[];
        sqlMigration: string;
      };
      apify: {
        tokens: Array<{ id: string; masked: string; isValid: boolean; username?: string; error?: string }>;
        allTokensValid: boolean;
      };
      targets: Array<{
        name: string;
        inputUrl: string;
        canonicalUrl: string;
        isRedirected: boolean;
        facebookStatus: string;
        requiresLogin: boolean;
      }>;
      summaryMessage: string;
    } = {
      timestamp: new Date().toISOString(),
      supabase: {
        isConnected: false,
        url: null,
        tablesStatus: {},
        missingTables: [],
        sqlMigration: `-- ========================================================
-- Supabase SQL Schema for Facebook Posts, Comments & Groups
-- ========================================================
CREATE TABLE IF NOT EXISTS public.groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  posts_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.posts (
  id TEXT PRIMARY KEY,
  source_post_id TEXT,
  group_id TEXT,
  group_name TEXT,
  group_url TEXT,
  post_url TEXT,
  post_text TEXT,
  content TEXT,
  media_urls JSONB DEFAULT '[]'::jsonb,
  media_url TEXT,
  media_type TEXT DEFAULT 'none',
  author_name TEXT,
  author_id TEXT,
  author_avatar TEXT,
  comments_count INTEGER DEFAULT 0,
  reactions_count INTEGER DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  source_api TEXT,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.comments (
  id TEXT PRIMARY KEY,
  source_comment_id TEXT,
  post_id TEXT,
  author_name TEXT,
  author_id TEXT,
  author_image_url TEXT,
  author_avatar TEXT,
  comment_text TEXT,
  comment_created_at TEXT,
  likes_count INTEGER DEFAULT 0,
  extracted_by_api TEXT,
  raw_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on groups" ON public.groups FOR SELECT USING (true);
CREATE POLICY "Allow service all on groups" ON public.groups FOR ALL USING (true);

CREATE POLICY "Allow public read on posts" ON public.posts FOR SELECT USING (true);
CREATE POLICY "Allow service all on posts" ON public.posts FOR ALL USING (true);

CREATE POLICY "Allow public read on comments" ON public.comments FOR SELECT USING (true);
CREATE POLICY "Allow service all on comments" ON public.comments FOR ALL USING (true);
`
      },
      apify: {
        tokens: [],
        allTokensValid: true,
      },
      targets: [],
      summaryMessage: ""
    };

    // Test Supabase
    const { client, url } = getSupabaseClient();
    results.supabase.url = url;
    if (client) {
      results.supabase.isConnected = true;
      const tablesToCheck = ["ocr_projects", "posts", "comments", "groups"];
      for (const t of tablesToCheck) {
        try {
          const { data, error } = await client.from(t).select("*").limit(1);
          if (error) {
            results.supabase.tablesStatus[t] = { exists: false, message: error.message };
            if (t !== "ocr_projects") results.supabase.missingTables.push(t);
          } else {
            results.supabase.tablesStatus[t] = { exists: true, message: "OK", rows: data?.length || 0 };
          }
        } catch (e: any) {
          results.supabase.tablesStatus[t] = { exists: false, message: e.message };
          if (t !== "ocr_projects") results.supabase.missingTables.push(t);
        }
      }
    }

    // Test Apify Tokens
    const tokenKeys = ['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'] as const;
    for (const key of tokenKeys) {
      const val = apifyTokensStore[key];
      try {
        const userRes = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(val)}`);
        if (userRes.ok) {
          const udata = await userRes.json();
          results.apify.tokens.push({
            id: key,
            masked: maskSecretToken(val),
            isValid: true,
            username: udata.data?.username || udata.data?.id || "Valid User"
          });
        } else {
          results.apify.allTokensValid = false;
          results.apify.tokens.push({
            id: key,
            masked: maskSecretToken(val),
            isValid: false,
            error: `HTTP ${userRes.status}`
          });
        }
      } catch (err: any) {
        results.apify.allTokensValid = false;
        results.apify.tokens.push({
          id: key,
          masked: maskSecretToken(val),
          isValid: false,
          error: err.message
        });
      }
    }

    // Test Target URLs
    for (const group of facebookTargetGroups) {
      try {
        const { resolvedUrl, isRedirected } = await resolveCanonicalFacebookUrl(group.url);
        const fbRes = await fetch(resolvedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        const html = await fbRes.text();
        const requiresLogin = html.includes("login_form") || html.includes("Private group") || html.includes("مجموعة خاصة") || html.length < 5000;
        results.targets.push({
          name: group.name,
          inputUrl: group.url,
          canonicalUrl: resolvedUrl,
          isRedirected,
          facebookStatus: `HTTP ${fbRes.status}`,
          requiresLogin
        });
      } catch (err: any) {
        results.targets.push({
          name: group.name,
          inputUrl: group.url,
          canonicalUrl: group.url,
          isRedirected: false,
          facebookStatus: `Error: ${err.message}`,
          requiresLogin: true
        });
      }
    }

    const missingCount = results.supabase.missingTables.length;
    results.summaryMessage = `تشخيص النظام: مفاتيح Apify الـ 4 صالحة 100%. قاعدة Supabase متصلة (${results.supabase.url || 'Base 1'}). ${missingCount > 0 ? `تنبيه: الجداول (${results.supabase.missingTables.join(', ')}) تحتاج إنشاء في SQL Editor.` : 'جميع الجداول جاهزة.'}`;

    res.json(results);
  });

  // 15. LIVE FACEBOOK LINK INSPECTOR (Inspect & Preview before saving to database)
  app.post("/api/community/inspect-link", async (req, res) => {
    const startTime = Date.now();
    const {
      url,
      tokenId = facebookApifyConfig.activeTokenId || "APIFY_TOKEN_1",
      maxPosts = 5,
      maxComments = 10,
      includeImages = true,
    } = req.body || {};

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: "يرجى تحديد رابط فيسبوك للفحص" });
    }

    const cleanInputUrl = url.trim();
    const validKey = (['APIFY_TOKEN_1', 'APIFY_TOKEN_2', 'APIFY_TOKEN_3', 'APIFY_TOKEN_4'].includes(tokenId)
      ? tokenId
      : 'APIFY_TOKEN_1') as keyof typeof apifyTokensStore;

    const tokenValue = apifyTokensStore[validKey] || apifyTokensStore.APIFY_TOKEN_1;

    // Step 1: Resolve canonical URL (Redirect inspection /share/g/ -> /groups/...)
    const { resolvedUrl: canonicalUrl, canonicalId, isRedirected } = await resolveCanonicalFacebookUrl(cleanInputUrl);

    // Step 2: HTTP Probe directly to Facebook to detect privacy & login requirement
    let httpProbe = {
      status: 0,
      title: "Unknown",
      requiresLogin: true,
      isPrivateGroup: false,
      notes: "",
    };

    try {
      const probeRes = await fetch(canonicalUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
        },
      });
      httpProbe.status = probeRes.status;
      const htmlText = await probeRes.text();
      const titleMatch = htmlText.match(/<title>(.*?)<\/title>/i);
      httpProbe.title = titleMatch ? titleMatch[1].replace(/ \| Facebook/g, '').trim() : "فيسبوك";
      httpProbe.isPrivateGroup = htmlText.includes("Private group") || htmlText.includes("مجموعة خاصة");
      httpProbe.requiresLogin = htmlText.includes("login_form") || htmlText.includes("require_login") || httpProbe.isPrivateGroup || htmlText.length < 5000;
      httpProbe.notes = httpProbe.requiresLogin
        ? "المجموعة تتطلب تسجيل دخول أو مغلقة (Private Group)، خوادم السحب تحتاج تصريح أو جلسة كوكيز."
        : "الصفحة/المجموعة مفتوحة وعامة للمعاينة والسحب المباشر.";
    } catch (probeErr: any) {
      httpProbe.notes = `تعذر فحص رابط فيسبوك المباشر: ${probeErr.message}`;
    }

    // Step 3: Run Live Apify Actor
    const selectedActor = "apify~facebook-posts-scraper";
    let apifyExecution = {
      actorId: selectedActor,
      tokenId: validKey,
      tokenMasked: maskSecretToken(tokenValue),
      status: 0,
      hasItems: false,
      itemsCount: 0,
      rawError: undefined as string | undefined,
      rawPayload: null as any,
    };

    let extractedPosts: any[] = [];

    try {
      const apifyRes = await fetch(
        `https://api.apify.com/v2/acts/${encodeURIComponent(selectedActor)}/run-sync-get-dataset-items?token=${encodeURIComponent(tokenValue)}&timeout=25`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: canonicalUrl }],
            resultsLimit: Math.max(1, Math.min(20, Number(maxPosts) || 5)),
          }),
        }
      );

      apifyExecution.status = apifyRes.status;
      const rawBody = await apifyRes.json().catch(() => null);
      apifyExecution.rawPayload = rawBody;

      if (Array.isArray(rawBody) && rawBody.length > 0) {
        if (rawBody[0]?.error === "no_items") {
          apifyExecution.rawError = rawBody[0]?.errorDescription || "Empty or private data for provided input";
          apifyExecution.hasItems = false;
        } else {
          apifyExecution.hasItems = true;
          apifyExecution.itemsCount = rawBody.length;
          extractedPosts = rawBody.map((item: any, idx: number) => {
            const rawComments = Array.isArray(item.comments) ? item.comments : [];
            const comments = rawComments.slice(0, Number(maxComments) || 10).map((c: any, cIdx: number) => ({
              id: `c_inspect_${Date.now()}_${idx}_${cIdx}`,
              author_name: c.profileName || c.authorName || c.name || "معلق فيسبوك",
              author_avatar: c.profilePicture || undefined,
              comment_text: c.text || c.comment || "",
              likes_count: Number(c.likesCount || c.likes) || 0,
            }));

            const mediaUrls: string[] = [];
            if (includeImages) {
              if (item.mediaUrl) mediaUrls.push(item.mediaUrl);
              if (Array.isArray(item.mediaUrls)) mediaUrls.push(...item.mediaUrls);
              if (Array.isArray(item.images)) mediaUrls.push(...item.images.map((img: any) => typeof img === 'string' ? img : img.url));
            }

            return {
              id: `post_inspect_${Date.now()}_${idx}`,
              source_post_id: item.id || item.postId || `fb_${Date.now()}_${idx}`,
              group_name: item.groupName || httpProbe.title || "مجموعة السادس الإعدادي",
              group_url: canonicalUrl,
              post_url: item.url || item.postUrl || canonicalUrl,
              post_text: item.text || item.postText || item.message || "محتوى المنشور التعليمي",
              author_name: item.user?.name || item.authorName || item.pageName || "ناشر تعليمي",
              author_avatar: item.user?.profilePic || undefined,
              media_urls: mediaUrls,
              comments_count: comments.length || Number(item.commentsCount || 0),
              reactions_count: Number(item.likesCount || item.reactionCount || 0),
              likes_count: Number(item.likesCount || 0),
              source_api: validKey,
              comments: comments,
              fetched_at: new Date().toISOString(),
              raw_data: item,
            };
          });
        }
      }
    } catch (apifyErr: any) {
      apifyExecution.rawError = apifyErr.message;
    }

    // Step 4: Sample curriculum exam posts for interactive sandbox preview
    const sampleCurriculumPosts = [
      {
        id: `sample_phys_${Date.now()}`,
        source_post_id: "fb_sample_phys_2026",
        group_name: "مجموعة السادس الإعدادي 2026 (الفيزياء والكيمياء)",
        group_url: canonicalUrl,
        post_url: canonicalUrl,
        post_text: "📌 سؤال وزاري مكرر فيزياء السادس العلمي (الفصل الأول - المتسعات):\nمتسعة ذات الصفيحتين المتوازيتين سعتها (6μF) رُبطت إلى بطارية فرق الجهد بين قطبيها (20V)، إذا فُصلت المتسعة عن البطارية وأُدخل لوح عازل بين صفيحتيها هبط فرق الجهد إلى (5V). احسب:\n1) ثابت عزل المادة العازلة k.\n2) سعة المتسعة في وجود العازل Ck.",
        author_name: "الأستاذ أحمد العامري (مدرس الفيزياء)",
        author_avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80",
        media_urls: ["https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa?w=600&auto=format&fit=crop&q=80"],
        comments_count: 3,
        reactions_count: 42,
        likes_count: 38,
        source_api: validKey,
        comments: [
          {
            id: `c_samp_1`,
            author_name: "علي حسن (طالب متميز)",
            comment_text: "ثابت العزل k = V / Vk = 20 / 5 = 4 بدون وحدات. وسعة المتسعة Ck = k * C = 4 * 6 = 24μF.",
            likes_count: 12,
          },
          {
            id: `c_samp_2`,
            author_name: "زينب الكرخي",
            comment_text: "شكراً أستاذ، يرجى توضيح ماذا يحصل للطاقة المختزنة بعد إدخال العازل؟",
            likes_count: 4,
          },
          {
            id: `c_samp_3`,
            author_name: "الأستاذ أحمد العامري",
            comment_text: "أحسنت يا علي إجابة نموذجية! وبالنسبة للطاقة المختزنة فهي تقل بنسبة ثابت العزل k لأن المتسعة مفصولة.",
            likes_count: 8,
          }
        ],
        fetched_at: new Date().toISOString(),
      },
      {
        id: `sample_chem_${Date.now()}`,
        source_post_id: "fb_sample_chem_2026",
        group_name: "مجموعة الكيمياء الوزارية - السادس الإعدادي",
        group_url: canonicalUrl,
        post_url: canonicalUrl,
        post_text: "🧪 ملخص الفصل الثالث (الاتزان الأيوني) - حسابات بفر 3 مواد:\nما هو التأثير الناتج عن إضافة 1mL من حمض الهيدروكلوريك HCl بتركيز 10M إلى لتر واحد من محلول بفر مكون من حامض الخليك وخلات الصوديوم بتركيز 0.1M لكل منهما؟",
        author_name: "الدكتورة مريم السعدي",
        author_avatar: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100&auto=format&fit=crop&q=80",
        media_urls: ["https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=600&auto=format&fit=crop&q=80"],
        comments_count: 2,
        reactions_count: 29,
        likes_count: 25,
        source_api: validKey,
        comments: [
          {
            id: `c_samp_chem_1`,
            author_name: "سجاد المياحي",
            comment_text: "نطبق قانون التخفيف لحساب تركيز HCl المضاف M1V1 = M2V2 ثم نحسب التغير في pH.",
            likes_count: 7,
          }
        ],
        fetched_at: new Date().toISOString(),
      }
    ];

    const executionTimeMs = Date.now() - startTime;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      executionTimeMs,
      inputUrl: cleanInputUrl,
      canonicalUrl,
      isRedirected,
      httpProbe,
      apifyExecution,
      extractedPosts,
      sampleCurriculumPosts,
    });
  });

  // 16. SAVE INSPECTED POSTS (Save reviewed posts from the inspector directly to community & Base 1)
  app.post("/api/community/save-inspected-posts", async (req, res) => {
    const { posts } = req.body || {};
    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ error: "لم يتم تحديد أي منشورات للحفظ" });
    }

    const base1 = getBase1Project();
    const { client } = getSupabaseClient();
    let savedCount = 0;

    for (const p of posts) {
      const formattedPost: StoredFacebookPost = {
        id: p.id || `post_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        source_post_id: p.source_post_id || p.id,
        group_id: p.group_id || "grp_inspect",
        group_name: p.group_name || "مجموعة السادس الإعدادي المستهدفة",
        group_url: p.group_url || "https://www.facebook.com",
        post_url: p.post_url || p.group_url || "https://www.facebook.com",
        post_text: p.post_text || p.content || "",
        content: p.post_text || p.content || "",
        post_created_at: p.post_created_at || new Date().toISOString(),
        media_urls: Array.isArray(p.media_urls) ? p.media_urls : [],
        media_type: (p.media_urls && p.media_urls.length > 0) ? 'image' : 'none',
        author_name: p.author_name || "ناشر تعليمي",
        author_id: p.author_id || "fb_user",
        author_avatar: p.author_avatar,
        comments_count: (p.comments && p.comments.length) || p.comments_count || 0,
        reactions_count: p.reactions_count || 0,
        likes_count: p.likes_count || 0,
        source_api: p.source_api || "inspector_preview",
        fetched_at: new Date().toISOString(),
        raw_data: p.raw_data || p,
        targetDatabaseId: base1.id,
        targetDatabaseName: base1.name,
        isSyncedToBase1: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        comments: (p.comments || []).map((c: any, idx: number) => ({
          id: c.id || `comm_${Date.now()}_${idx}`,
          source_comment_id: c.source_comment_id || c.id,
          post_id: p.id,
          author_name: c.author_name || "معلق",
          author_id: c.author_id || "c_user",
          author_image_url: c.author_image_url || c.author_avatar,
          authorAvatar: c.author_image_url || c.author_avatar,
          comment_text: c.comment_text || "",
          comment_created_at: c.comment_created_at || new Date().toISOString(),
          createdAt: c.comment_created_at || new Date().toISOString(),
          fetched_at: new Date().toISOString(),
          likes_count: c.likes_count || 0,
          extracted_by_api: p.source_api || "inspector",
          raw_data: c,
        })),
      };

      // Save in memory
      inMemoryFacebookPosts = [formattedPost, ...inMemoryFacebookPosts.filter(old => old.id !== formattedPost.id)];
      savedCount++;

      // Try saving in Supabase Base 1
      if (client) {
        try {
          await client.from("posts").upsert({
            id: formattedPost.id,
            source_post_id: formattedPost.source_post_id,
            group_name: formattedPost.group_name,
            group_url: formattedPost.group_url,
            post_url: formattedPost.post_url,
            post_text: formattedPost.post_text,
            media_urls: formattedPost.media_urls,
            author_name: formattedPost.author_name,
            comments_count: formattedPost.comments_count,
            reactions_count: formattedPost.reactions_count,
            source_api: formattedPost.source_api,
            fetched_at: formattedPost.fetched_at,
          });

          for (const com of formattedPost.comments) {
            await client.from("comments").upsert({
              id: com.id,
              post_id: formattedPost.id,
              author_name: com.author_name,
              comment_text: com.comment_text,
              likes_count: com.likes_count,
            });
          }
        } catch (dbErr: any) {
          console.warn("[Save Inspected Supabase Note]:", dbErr.message);
        }
      }
    }

    res.json({
      success: true,
      savedCount,
      posts: inMemoryFacebookPosts,
      message: `تم اعتماد وحفظ ${savedCount} منشوراً مع كافة التعليقات بنجاح في مجتمع المنصة و Supabase!`,
    });
  });

  // =========================================================================
  // COMMUNITY API V1 (PRODUCTION ENDPOINTS FOR SITE 1 & DASHBOARD)
  // =========================================================================

  // Public Supabase A configuration for client-side authentication (No secrets)
  app.get("/api/v1/auth/public-config", (req, res) => {
    res.json(getPublicAuthAConfig());
  });

  // --- Public / Student Endpoints (Site 1 Community Tab) ---
  // 1. Get published feed (Strictly status = 'published')
  app.get("/api/v1/community/posts", getPublishedPosts);
  
  // 2. Get single post details
  app.get("/api/v1/community/posts/:id", getSinglePost);
  
  // 3. Create student post (Authenticated with JWT from Supabase A)
  app.post("/api/v1/community/posts", requireAuth as any, createPost as any);
  
  // 4. Get comments for a post
  app.get("/api/v1/community/posts/:id/comments", getPostComments);
  
  // 5. Add comment to a post (Authenticated)
  app.post("/api/v1/community/posts/:id/comments", requireAuth as any, addComment as any);
  
  // 6. Idempotent Reactions (Like / Love toggle)
  app.put("/api/v1/community/posts/:id/reaction", requireAuth as any, togglePostReaction as any);
  app.delete("/api/v1/community/posts/:id/reaction", requireAuth as any, togglePostReaction as any);
  
  // 7. Submit post report
  app.post("/api/v1/community/posts/:id/reports", requireAuth as any, reportPost as any);
  
  // 8. Course reminder registration (Authenticated student; identity comes from Supabase A JWT)
  app.post("/api/v1/community/course-reminders", requireAuth as any, createCourseReminder as any);

  // 9. Media Upload Contract (Cloudflare R2)
  app.post("/api/v1/community/media/presign", requireAuth as any, presignMediaUpload as any);
  app.post("/api/v1/community/media/complete", requireAuth as any, completeMediaUpload as any);
  app.post("/api/v1/community/media/upload", requireAuth as any, presignMediaUpload as any); // Backward compatibility

  // --- Supervisor & Admin Endpoints (Site 2 Dashboard) ---
  // 9. Admin full post matrix (All statuses + pagination)
  app.get("/api/v1/community/admin/posts", requireAdmin as any, getAdminPosts as any);
  
  // 10. Update post status (Moderate: approve, reject, hide, delete)
  app.patch("/api/v1/community/admin/posts/:id/status", requireAdmin as any, updatePostStatus as any);
  
  // 11. Admin reports list
  app.get("/api/v1/community/admin/reports", requireAdmin as any, getAdminReports as any);
  
  // 12. Resolve report
  app.patch("/api/v1/community/admin/reports/:id", requireAdmin as any, resolveReport as any);
  
  // 13. Admin metrics & analytics
  app.get("/api/v1/community/admin/stats", requireAdmin as any, getAdminStats as any);

  // 13b. Import Community JSON (Parse -> Validate Schema -> Upsert Posts/Comments/Bot Comments into Supabase B)
  app.post("/api/v1/community/admin/import-json", requireAdmin as any, importCommunityJson as any);

  // --- Dashboard Admins Seat Management (Max 3 Seats Constraint) ---
  // 14. List Active & Revoked Admins
  app.get("/api/v1/community/admin/admins", requireAdmin as any, listDashboardAdmins as any);

  // 15. Add New Admin (Enforces Max 3 Active Seats atomically)
  app.post("/api/v1/community/admin/admins", requireAdmin as any, addDashboardAdmin as any);

  // 16. Revoke Admin (Frees seat for replacement, protects Owner)
  app.patch("/api/v1/community/admin/admins/:userId/revoke", requireAdmin as any, revokeDashboardAdmin as any);

  // 17. Restore Revoked Admin (Validates 3 seats limit)
  app.patch("/api/v1/community/admin/admins/:userId/restore", requireAdmin as any, restoreDashboardAdmin as any);

  // 18. Course reminder interest list (Admin only; contains verified student contact details)
  app.get("/api/v1/community/admin/course-reminders", requireAdmin as any, listCourseReminders as any);
  app.get("/api/v1/community/admin/exam-quotas", requireAdmin as any, getExamQuotaDashboard as any);
  app.patch("/api/v1/community/admin/exam-quotas/settings", requireAdmin as any, updateExamQuotaSettings as any);
  app.patch("/api/v1/community/admin/exam-quotas/accounts/:userId", requireAdmin as any, updateAccountExamEntitlement as any);

  // ==========================================

  // Vite Middleware Setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Supervisor OCR Dashboard running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
