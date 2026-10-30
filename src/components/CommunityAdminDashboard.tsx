import React, { useState, useMemo, useCallback } from 'react';
import {
  Shield,
  Eye,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Filter,
  Search,
  Layers,
  Sparkles,
  Plus,
  RefreshCw,
  Edit3,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Database,
  ArrowUpDown,
  SlidersHorizontal,
  Clock,
  UserCheck,
  Flag,
  MessageSquare,
  ThumbsUp,
  Image as ImageIcon,
  CheckSquare,
  Square,
  AlertCircle,
  FileText,
  UploadCloud,
  Code,
  FileJson,
  X
} from 'lucide-react';
import { FacebookPost, FacebookComment } from '../types';
import { importCommunityJsonData, getStoredAuthToken, setStoredAuthToken } from '../api';
import { DashboardAdminsManagement } from './DashboardAdminsManagement';
import { SupabaseAdminLogin } from './SupabaseAdminLogin';
import { ExamQuotaManagement } from './ExamQuotaManagement';

interface CommunityAdminDashboardProps {
  posts: FacebookPost[];
  onDeletePost: (postId: string) => Promise<void> | void;
  onUpdatePostStatus: (postId: string, newStatus: 'published' | 'pending' | 'rejected' | 'hidden' | 'deleted') => Promise<void> | void;
  onBulkAction: (action: 'delete' | 'approve' | 'reject' | 'hide', postIds: string[]) => Promise<void> | void;
  onSwitchToUserView: () => void;
  onRefreshData: () => Promise<void> | void;
  onOpenCreatePostModal: () => void;
}

export function CommunityAdminDashboard({
  posts,
  onDeletePost,
  onUpdatePostStatus,
  onBulkAction,
  onSwitchToUserView,
  onRefreshData,
  onOpenCreatePostModal
}: CommunityAdminDashboardProps) {
  // Filters and Pagination
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'pending' | 'rejected' | 'hidden'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'user' | 'apify_scraped' | 'import'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [itemsPerPage, setItemsPerPage] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'likes' | 'comments'>('newest');

  // Selected Posts for Bulk Actions
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [isProcessingBulk, setIsProcessingBulk] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Admin Auth Session Token State
  const [sessionToken, setSessionToken] = useState<string>(() => getStoredAuthToken());
  const [isTokenModalOpen, setIsTokenModalOpen] = useState<boolean>(false);
  const [tempTokenInput, setTempTokenInput] = useState<string>('');

  const handleSupabaseSessionChange = useCallback((token: string) => {
    setSessionToken(token);
    setStoredAuthToken(token);
  }, []);

  // Direct Community JSON Importer State
  const [isCommunityJsonModalOpen, setIsCommunityJsonModalOpen] = useState<boolean>(false);
  const [rawCommunityJson, setRawCommunityJson] = useState<string>('');
  const [batchTargetGroup, setBatchTargetGroup] = useState<string>('مجموعة منهاج وأسئلة السادس الإعدادي 2026');
  const [batchAutoApprove, setBatchAutoApprove] = useState<boolean>(true);
  const [isSubmittingBatch, setIsSubmittingBatch] = useState<boolean>(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchSuccessMsg, setBatchSuccessMsg] = useState<string | null>(null);
  const [batchReport, setBatchReport] = useState<any | null>(null);

  // Active Admin Sub-tab
  const [adminTab, setAdminTab] = useState<'matrix' | 'pending_queue' | 'reports' | 'admins' | 'exam_quotas'>('matrix');

  // Quick stats calculation
  const stats = useMemo(() => {
    const total = posts.length;
    // Assume posts with status, default to published or check source_api
    const published = posts.filter(p => (p as any).status === 'published' || !(p as any).status).length;
    const pending = posts.filter(p => (p as any).status === 'pending' || (p as any).status === 'pending_review').length;
    const rejected = posts.filter(p => (p as any).status === 'rejected').length;
    const hidden = posts.filter(p => (p as any).status === 'hidden').length;
    const importedCount = posts.filter(p => p.source_api === 'apify_scraped' || p.source_type === 'manual_json_import').length;
    const totalComments = posts.reduce((acc, p) => acc + (p.comments?.length || p.comments_count || 0), 0);
    const totalLikes = posts.reduce((acc, p) => acc + (p.likes_count || p.reactions_count || 0), 0);

    return { total, published, pending, rejected, hidden, importedCount, totalComments, totalLikes };
  }, [posts]);

  // Filtered and Sorted Posts
  const filteredPosts = useMemo(() => {
    return posts.filter(post => {
      // Status filter
      const postStatus = (post as any).status || 'published';
      if (statusFilter !== 'all' && postStatus !== statusFilter) {
        return false;
      }

      // Source filter
      if (sourceFilter !== 'all') {
        if (sourceFilter === 'apify_scraped' && post.source_api !== 'apify_scraped') return false;
        if (sourceFilter === 'user' && post.source_api === 'apify_scraped') return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const text = (post.post_text || post.content || '').toLowerCase();
        const author = (post.author_name || '').toLowerCase();
        const group = (post.group_name || '').toLowerCase();
        const id = post.id.toLowerCase();
        if (!text.includes(q) && !author.includes(q) && !group.includes(q) && !id.includes(q)) {
          return false;
        }
      }

      return true;
    }).sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.created_at || b.fetched_at || 0).getTime() - new Date(a.created_at || a.fetched_at || 0).getTime();
      }
      if (sortBy === 'oldest') {
        return new Date(a.created_at || a.fetched_at || 0).getTime() - new Date(b.created_at || b.fetched_at || 0).getTime();
      }
      if (sortBy === 'likes') {
        return (b.likes_count || 0) - (a.likes_count || 0);
      }
      if (sortBy === 'comments') {
        return (b.comments?.length || b.comments_count || 0) - (a.comments?.length || a.comments_count || 0);
      }
      return 0;
    });
  }, [posts, statusFilter, sourceFilter, searchQuery, sortBy]);

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / itemsPerPage));
  const paginatedPosts = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredPosts.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredPosts, currentPage, itemsPerPage]);

  // Selection handlers
  const allCurrentPageSelected = paginatedPosts.length > 0 && paginatedPosts.every(p => selectedIds[p.id]);
  const someSelected = Object.values(selectedIds).some(Boolean);
  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  const toggleSelectAll = () => {
    if (allCurrentPageSelected) {
      const updated = { ...selectedIds };
      paginatedPosts.forEach(p => delete updated[p.id]);
      setSelectedIds(updated);
    } else {
      const updated = { ...selectedIds };
      paginatedPosts.forEach(p => { updated[p.id] = true; });
      setSelectedIds(updated);
    }
  };

  const toggleSelectPost = (id: string) => {
    setSelectedIds(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleExecuteBulk = async (action: 'delete' | 'approve' | 'reject' | 'hide') => {
    const targetIds = Object.keys(selectedIds).filter(id => selectedIds[id]);
    if (targetIds.length === 0) return;

    const confirmMsg = action === 'delete'
      ? `هل أنت متأكد من حذف ${targetIds.length} منشور نهائياً من قاعدة المجتمع؟`
      : `هل أنت متأكد من تطبيق إجراء (${action}) على ${targetIds.length} منشور؟`;

    if (!window.confirm(confirmMsg)) return;

    setIsProcessingBulk(true);
    try {
      await onBulkAction(action, targetIds);
      setSelectedIds({});
    } finally {
      setIsProcessingBulk(false);
    }
  };

  const handleDeleteSingle = async (postId: string) => {
    if (!window.confirm('هل تريد بالتأكيد حذف هذا المنشور نهائياً من قاعدة Supabase B؟')) {
      return;
    }
    setDeletingId(postId);
    try {
      await onDeletePost(postId);
    } finally {
      setDeletingId(null);
    }
  };

  const handleStatusChange = async (postId: string, newStatus: 'published' | 'pending' | 'rejected' | 'hidden') => {
    setUpdatingId(postId);
    try {
      await onUpdatePostStatus(postId, newStatus);
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <SupabaseAdminLogin onSessionChange={handleSupabaseSessionChange} />

      {/* ========================================================================= */}
      {/* 1. TOP DUAL-MODE BANNER (مفتاح تبديل الوضع بين: لوحة الإدارة ومعاينة المستخدم) */}
      {/* ========================================================================= */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-950 text-white rounded-2xl p-5 sm:p-6 shadow-xl border border-slate-800 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>
        
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-full bg-blue-500/20 text-blue-300 border border-blue-400/30 text-xs font-bold flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-blue-400" />
                مركز التحكم الإداري (Admin Control Matrix)
              </span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold flex items-center gap-1">
                <Database className="w-3 h-3 text-emerald-400" />
                Supabase B (OCR-1)
              </span>
              <button
                onClick={() => {
                  setTempTokenInput(getStoredAuthToken());
                  setIsTokenModalOpen(true);
                }}
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border transition-colors flex items-center gap-1 cursor-pointer ${
                  sessionToken
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                }`}
                title="إدارة مفتاح توثيق جلسة المشرف (JWT Auth Token)"
              >
                <UserCheck className="w-3 h-3" />
                <span>{sessionToken ? 'جلسة المشرف: نشطة' : 'جلسة المشرف: افتراضية / إضافة رمز'}</span>
              </button>
            </div>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white flex items-center gap-2">
              إدارة منشورات ومجتمع المنصة التعليمية
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
              تحكم كامل في المنشورات، قبول أو رفض محتوى البوتات وسحب الأسئلة، حذف المنشورات، ومتابعة المشرفين والإحصائيات الحية.
            </p>
          </div>

          {/* DUAL INGESTION & USER PREVIEW ACTION BUTTONS */}
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto self-stretch md:self-auto">
            {/* Action 1: User / Student View */}
            <button
              onClick={onSwitchToUserView}
              className="flex-1 md:flex-initial inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 text-xs font-bold transition-all transform active:scale-95 cursor-pointer shadow-sm"
              title="انتقل إلى العرض كما يراه الطالب في المنصة"
            >
              <Eye className="w-4 h-4 text-cyan-400" />
              <span>معاينة كطالب</span>
            </button>

            {/* Method 1: Regular Student Post */}
            <button
              onClick={onOpenCreatePostModal}
              className="flex-1 md:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black transition-all transform active:scale-95 cursor-pointer shadow-md shadow-blue-600/40"
              title="الطريقة 1: نشر منشور من مستخدم في المنصة التعليمية"
            >
              <Plus className="w-4 h-4" />
              <span>نشر كطالب (طريقة 1)</span>
            </button>

            {/* Method 2: Direct community.json Upload */}
            <button
              onClick={() => {
                setBatchError(null);
                setBatchSuccessMsg(null);
                setBatchReport(null);
                setIsCommunityJsonModalOpen(true);
              }}
              className="flex-1 md:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-black transition-all transform active:scale-95 cursor-pointer shadow-md shadow-purple-600/40"
              title="رفع واستيراد ملف community.json مباشرة إلى قاعدة Supabase B مع التحقق من المخطط"
            >
              <UploadCloud className="w-4 h-4 text-purple-200" />
              <span>رفع ملف community.json (استيراد مباشر)</span>
            </button>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. ADMIN STATS CARDS (بطاقات المؤشرات الإدارية الحية) */}
      {/* ========================================================================= */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-bold">إجمالي المنشورات</span>
            <Layers className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-black text-slate-900">{stats.total}</div>
          <span className="text-[10px] text-slate-400 mt-1 font-medium">في قاعدة Supabase B</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-emerald-200/80 shadow-xs flex flex-col justify-between bg-emerald-50/20">
          <div className="flex items-center justify-between text-emerald-700 mb-1">
            <span className="text-xs font-bold">منشور ومقبول</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-black text-emerald-700">{stats.published}</div>
          <span className="text-[10px] text-emerald-600 mt-1 font-medium">مرئي للطلاب</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-amber-200/80 shadow-xs flex flex-col justify-between bg-amber-50/20">
          <div className="flex items-center justify-between text-amber-700 mb-1">
            <span className="text-xs font-bold">قيد المراجعة</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-black text-amber-700">{stats.pending}</div>
          <span className="text-[10px] text-amber-600 mt-1 font-medium">مستورد / بوت</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-purple-200/80 shadow-xs flex flex-col justify-between bg-purple-50/20">
          <div className="flex items-center justify-between text-purple-700 mb-1">
            <span className="text-xs font-bold">منشورات مستوردة</span>
            <Sparkles className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-2xl font-black text-purple-700">{stats.importedCount}</div>
          <span className="text-[10px] text-purple-600 mt-1 font-medium">أسئلة ومنهاج</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-blue-200/80 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-blue-700 mb-1">
            <span className="text-xs font-bold">التعليقات</span>
            <MessageSquare className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-black text-blue-700">{stats.totalComments}</div>
          <span className="text-[10px] text-blue-500 mt-1 font-medium">ردود وتفاعلات</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-red-200/80 shadow-xs flex flex-col justify-between bg-red-50/20">
          <div className="flex items-center justify-between text-red-700 mb-1">
            <span className="text-xs font-bold">البلاغات المفتوحة</span>
            <Flag className="w-4 h-4 text-red-600" />
          </div>
          <div className="text-2xl font-black text-red-700">0</div>
          <span className="text-[10px] text-red-500 mt-1 font-medium">تحت المعالجة</span>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. ADMIN SUB-NAVIGATION TABS (تبويبات الإدارة المخصصة) */}
      {/* ========================================================================= */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setAdminTab('matrix')}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
            adminTab === 'matrix'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>جدول إدارة المنشورات ({filteredPosts.length})</span>
        </button>

        <button
          onClick={() => {
            setAdminTab('pending_queue');
            setStatusFilter('pending');
          }}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
            adminTab === 'pending_queue'
              ? 'bg-amber-600 text-white shadow-xs'
              : 'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200/60'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>طابور المراجعة المعلق ({stats.pending})</span>
        </button>

        <button
          onClick={() => setAdminTab('reports')}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
            adminTab === 'reports'
              ? 'bg-red-600 text-white shadow-xs'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <Flag className="w-3.5 h-3.5" />
          <span>إدارة البلاغات (0)</span>
        </button>

        <button
          onClick={() => setAdminTab('admins')}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
            adminTab === 'admins'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-indigo-50 text-indigo-800 hover:bg-indigo-100 border border-indigo-200/60'
          }`}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>حسابات المشرفين (3 مقاعد)</span>
        </button>

        <button
          onClick={() => setAdminTab('exam_quotas')}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${adminTab === 'exam_quotas' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200/60'}`}
        >
          <UserCheck className="w-3.5 h-3.5" />
          <span>حدود امتحانات موقع A</span>
        </button>

        <div className="mr-auto">
          <button
            onClick={() => onRefreshData()}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors cursor-pointer"
            title="تحديث البيانات من Supabase B"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. TAB VIEWS (عرض التبويب المختار) */}
      {/* ========================================================================= */}
      {adminTab === 'admins' ? (
        <DashboardAdminsManagement />
      ) : adminTab === 'exam_quotas' ? (
        <ExamQuotaManagement />
      ) : (
        <>
          {/* 4. ADMIN FILTER & TOOLBAR (أدوات التصفية والتحكم بعدد المنشورات) */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="ابحث في نصوص المنشورات، الأسماء، أو المعرف ID..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full pl-3 pr-9 py-2 rounded-xl border border-slate-200 text-xs font-medium focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden"
            />
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setCurrentPage(1);
              }}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 bg-slate-50 focus:ring-2 focus:ring-blue-500 outline-hidden cursor-pointer"
            >
              <option value="all">كل الحالات ({posts.length})</option>
              <option value="published">منشور ومقبول ({stats.published})</option>
              <option value="pending">قيد المراجعة ({stats.pending})</option>
              <option value="rejected">مرفوض ({stats.rejected})</option>
              <option value="hidden">مخفي ({stats.hidden})</option>
            </select>

            {/* Source Filter */}
            <select
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value as any);
                setCurrentPage(1);
              }}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 bg-slate-50 focus:ring-2 focus:ring-blue-500 outline-hidden cursor-pointer"
            >
              <option value="all">كل المصادر</option>
              <option value="user">مستخدمون عاديون</option>
              <option value="apify_scraped">سحب Apify خارجي</option>
            </select>

            {/* Items Per Page (تحديد عدد المنشورات المعروضة) */}
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1">
              <span className="text-[11px] text-slate-500 font-bold">عرض:</span>
              <select
                value={itemsPerPage}
                onChange={(e) => {
                  setItemsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-transparent text-xs font-black text-blue-600 outline-hidden cursor-pointer"
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
              <span className="text-[11px] text-slate-500 font-bold">منشور</span>
            </div>
          </div>
        </div>

        {/* Bulk Action Bar (عند تحديد عناصر) */}
        {someSelected && (
          <div className="flex items-center justify-between gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs font-bold text-blue-900 animate-in fade-in duration-150">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-blue-600" />
              <span>تم تحديد {selectedCount} منشور</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleExecuteBulk('approve')}
                disabled={isProcessingBulk}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors cursor-pointer flex items-center gap-1 text-[11px]"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>قبول ونشر المحدد</span>
              </button>

              <button
                onClick={() => handleExecuteBulk('reject')}
                disabled={isProcessingBulk}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold transition-colors cursor-pointer flex items-center gap-1 text-[11px]"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>رفض المحدد</span>
              </button>

              <button
                onClick={() => handleExecuteBulk('delete')}
                disabled={isProcessingBulk}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold transition-colors cursor-pointer flex items-center gap-1 text-[11px]"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>حذف نهائي</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 5. POSTS MANAGEMENT TABLE (جدول إدارة المنشورات الحقيقي) */}
      {/* ========================================================================= */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        {paginatedPosts.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
              <Search className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-slate-800">لا توجد منشورات تطابق شروط الفلترة الحالية</h3>
            <p className="text-xs text-slate-500">حاول تغيير معايير البحث أو اختيار حالة أخرى.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-black">
                  <th className="py-3 px-4 w-10">
                    <button
                      onClick={toggleSelectAll}
                      className="cursor-pointer text-slate-400 hover:text-slate-600"
                    >
                      {allCurrentPageSelected ? (
                        <CheckSquare className="w-4 h-4 text-blue-600" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>
                  </th>
                  <th className="py-3 px-4">صاحب المنشور والمصدر</th>
                  <th className="py-3 px-4">محتوى المنشور والوسائط</th>
                  <th className="py-3 px-4 text-center">التفاعل</th>
                  <th className="py-3 px-4 text-center">الحالة</th>
                  <th className="py-3 px-4 text-center">تاريخ النشر/السحب</th>
                  <th className="py-3 px-4 text-center">الإجراءات الإدارية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedPosts.map((post) => {
                  const isSelected = !!selectedIds[post.id];
                  const postStatus = (post as any).status || 'published';
                  const isBot = post.source_api === 'apify_scraped' || post.source_type === 'manual_json_import' || (post as any).is_bot || !!(post.author_profile_id && post.author_profile_id.startsWith('bot_'));
                  const isApify = post.source_api === 'apify_scraped';

                  return (
                    <tr
                      key={post.id}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        isSelected ? 'bg-blue-50/40' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-4">
                        <button
                          onClick={() => toggleSelectPost(post.id)}
                          className="cursor-pointer text-slate-400 hover:text-slate-600"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>

                      {/* Author & Source */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-slate-700 text-xs overflow-hidden shrink-0">
                            {post.author_avatar ? (
                              <img src={post.author_avatar} alt="" className="w-full h-full object-cover" />
                            ) : (
                              (post.author_name || 'U')[0]
                            )}
                          </div>
                          <div>
                            <div className="font-bold text-slate-900 leading-tight">
                              {post.author_name || 'مستخدم المنصة'}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              {isBot ? (
                                <span className="px-1.5 py-0.2 rounded bg-purple-100 text-purple-700 text-[10px] font-bold">
                                  {isApify ? 'Apify Bot' : 'Bot Profile'}
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded bg-blue-100 text-blue-700 text-[10px] font-bold">
                                  طالب / User
                                </span>
                              )}
                              <span className="text-[10px] text-slate-400 font-mono truncate max-w-[90px]">
                                {post.id}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Content Snippet & Media */}
                      <td className="py-3 px-4 max-w-xs sm:max-w-md">
                        <p className="line-clamp-2 text-slate-700 font-normal leading-relaxed">
                          {post.post_text || post.content || 'منشور بدون نص'}
                        </p>
                        {post.media_urls && post.media_urls.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[10px] text-blue-600 font-bold flex items-center gap-1">
                              <ImageIcon className="w-3 h-3" />
                              {post.media_urls.length} صور مرفقة
                            </span>
                            <div className="flex -space-x-1.5 space-x-reverse">
                              {post.media_urls.slice(0, 3).map((img, idx) => (
                                <img
                                  key={idx}
                                  src={img}
                                  alt=""
                                  className="w-5 h-5 rounded-md object-cover border border-white shadow-xs"
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Engagement */}
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-2 text-slate-600 text-xs">
                          <span className="flex items-center gap-1" title="إعجابات">
                            <ThumbsUp className="w-3 h-3 text-blue-500" />
                            {post.likes_count || post.reactions_count || 0}
                          </span>
                          <span className="flex items-center gap-1" title="تعليقات">
                            <MessageSquare className="w-3 h-3 text-slate-400" />
                            {post.comments?.length || post.comments_count || 0}
                          </span>
                        </div>
                      </td>

                      {/* Status Badge */}
                      <td className="py-3 px-4 text-center">
                        {postStatus === 'published' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">
                            <CheckCircle2 className="w-3 h-3" />
                            مقبول ومنشور
                          </span>
                        )}
                        {postStatus === 'pending' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold animate-pulse">
                            <Clock className="w-3 h-3" />
                            قيد المراجعة
                          </span>
                        )}
                        {postStatus === 'rejected' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-100 text-red-800 text-[11px] font-bold">
                            <XCircle className="w-3 h-3" />
                            مرفوض
                          </span>
                        )}
                        {postStatus === 'hidden' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold">
                            <Eye className="w-3 h-3" />
                            مخفي
                          </span>
                        )}
                      </td>

                      {/* Date */}
                      <td className="py-3 px-4 text-center text-slate-500 text-[11px]">
                        {post.created_at || post.fetched_at ? (
                          new Date(post.created_at || post.fetched_at || '').toLocaleDateString('ar-EG', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        ) : (
                          'الآن'
                        )}
                      </td>

                      {/* Action Buttons */}
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {/* Quick Approve if pending */}
                          {postStatus === 'pending' && (
                            <button
                              onClick={() => handleStatusChange(post.id, 'published')}
                              disabled={updatingId === post.id}
                              className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors cursor-pointer"
                              title="قبول ونشر فوراً"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                          )}

                          {/* Quick Reject */}
                          {postStatus !== 'rejected' && (
                            <button
                              onClick={() => handleStatusChange(post.id, 'rejected')}
                              disabled={updatingId === post.id}
                              className="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 transition-colors cursor-pointer"
                              title="رفض المنشور"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          )}

                          {/* Quick Delete */}
                          <button
                            onClick={() => handleDeleteSingle(post.id)}
                            disabled={deletingId === post.id}
                            className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 transition-colors cursor-pointer"
                            title="حذف نهائي من قاعدة البيانات"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 6. PAGINATION CONTROLS (الترقيم والتحكم بالصفحات) */}
        {/* ========================================================================= */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="text-slate-600 font-medium">
            عرض {Math.min(filteredPosts.length, (currentPage - 1) * itemsPerPage + 1)} إلى{' '}
            {Math.min(filteredPosts.length, currentPage * itemsPerPage)} من أصل {filteredPosts.length} منشور
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <span className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 font-bold text-slate-800">
              صفحة {currentPage} من {totalPages}
            </span>

            <button
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
        </>
      )}

      {/* ========================================================================= */}
      {/* 7. DIRECT COMMUNITY JSON IMPORT MODAL (استيراد ومعالجة ملف community.json) */}
      {/* ========================================================================= */}
      {isCommunityJsonModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="px-6 py-4 bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center">
                  <UploadCloud className="w-4 h-4 text-purple-300" />
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-tight flex items-center gap-2">
                    استيراد ملف community.json إلى قاعدة Supabase B
                  </h3>
                  <p className="text-[11px] text-purple-200">
                    التحقق من المخطط، إدخال المنشورات والتعليقات وردود البوتات مع تفاصيل التقرير
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsCommunityJsonModalOpen(false)}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {batchError && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs font-bold text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                  <span>{batchError}</span>
                </div>
              )}

              {batchSuccessMsg && (
                <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-700 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{batchSuccessMsg}</span>
                </div>
              )}

              {/* Import Metrics Report Display */}
              {batchReport && (
                <div className="p-4 bg-slate-900 text-slate-100 rounded-xl border border-slate-700 space-y-3">
                  <div className="flex items-center justify-between text-xs font-bold text-emerald-400 border-b border-slate-800 pb-2">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      تقرير المعالجة والاستيراد (Supabase B)
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {batchReport.duration_ms} ms
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                    <div className="p-2.5 bg-slate-800/80 rounded-lg border border-slate-700">
                      <div className="text-[10px] text-slate-400 font-bold">هويات البروفايل (Profiles)</div>
                      <div className="text-base font-black text-cyan-400">+{batchReport.profiles?.inserted || 0}</div>
                      <div className="text-[9px] text-slate-400">محدث: {batchReport.profiles?.updated || 0}</div>
                    </div>
                    <div className="p-2.5 bg-slate-800/80 rounded-lg border border-slate-700">
                      <div className="text-[10px] text-slate-400 font-bold">المنشورات المضافة</div>
                      <div className="text-base font-black text-emerald-400">+{batchReport.posts?.inserted || 0}</div>
                      <div className="text-[9px] text-slate-400">محدث: {batchReport.posts?.updated || 0}</div>
                    </div>
                    <div className="p-2.5 bg-slate-800/80 rounded-lg border border-slate-700">
                      <div className="text-[10px] text-slate-400 font-bold">التعليقات المضافة</div>
                      <div className="text-base font-black text-purple-400">+{batchReport.comments?.inserted || 0}</div>
                      <div className="text-[9px] text-slate-400">محدث: {batchReport.comments?.updated || 0}</div>
                    </div>
                    <div className="p-2.5 bg-slate-800/80 rounded-lg border border-slate-700">
                      <div className="text-[10px] text-slate-400 font-bold">ردود البوتات (Bot)</div>
                      <div className="text-base font-black text-amber-400">{batchReport.bot_comments ?? batchReport.comments?.bot_comments ?? 0}</div>
                      <div className="text-[9px] text-amber-300/70">تمت معالجتها</div>
                    </div>
                    <div className="p-2.5 bg-slate-800/80 rounded-lg border border-slate-700">
                      <div className="text-[10px] text-slate-400 font-bold">معرفات user_id المتجاهلة</div>
                      <div className="text-base font-black text-teal-400">{batchReport.ignored_user_ids || 0}</div>
                      <div className="text-[9px] text-teal-300/70">حماية الخصوصية 🛡️</div>
                    </div>
                  </div>

                  {batchReport.skipped_reasons && batchReport.skipped_reasons.length > 0 && (
                    <div className="p-2.5 bg-amber-950/40 border border-amber-800/60 rounded-lg text-[11px] text-amber-200">
                      <span className="font-bold block mb-1">ملاحظات التخطي:</span>
                      <ul className="list-disc list-inside space-y-0.5 text-amber-300">
                        {batchReport.skipped_reasons.map((r: string, rIdx: number) => (
                          <li key={rIdx}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Group Target Selection */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  المجموعة الافتراضية للمنشورات:
                </label>
                <input
                  type="text"
                  value={batchTargetGroup}
                  onChange={(e) => setBatchTargetGroup(e.target.value)}
                  placeholder="مثال: مجموعة منهاج وأسئلة السادس الإعدادي 2026"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:ring-2 focus:ring-purple-500 outline-hidden"
                />
              </div>

              {/* Auto Approve Toggle */}
              <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-xl">
                <div>
                  <div className="text-xs font-bold text-slate-800">حالة النشر التلقائي:</div>
                  <div className="text-[11px] text-slate-500">
                    {batchAutoApprove
                      ? 'سيتم نشر المنشورات فوراً للطلاب (Published)'
                      : 'سيتم وضع المنشورات في طابور المراجعة (Pending) لتعتمدها يدوياً'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setBatchAutoApprove(!batchAutoApprove)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer ${
                    batchAutoApprove
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {batchAutoApprove ? 'موافقة ونشر فوري ✅' : 'تحويل للمراجعة ⏳'}
                </button>
              </div>

              {/* JSON Textarea or Upload */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <Code className="w-3.5 h-3.5 text-purple-600" />
                    <span>مصفوفة بيانات JSON أو كائن المنشورات:</span>
                  </label>
                  
                  {/* Quick Sample JSON Button */}
                  <button
                    type="button"
                    onClick={() => {
                      const sample = [
                        {
                          id: `post_sample_${Date.now()}_1`,
                          content: "سؤال وزاري مهم جداً في الفصل الثالث مادة الرياضيات السادس العلمي (موضوع المعدلات الزمنية) - تفاعلوا بالحلول في التعليقات.",
                          author_display_name: "الأستاذ علي الكرخي",
                          post_type: "curriculum",
                          likes_count: 84,
                          media_urls: ["https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=600&auto=format&fit=crop&q=80"],
                          comments: [
                            {
                              id: `cmt_bot_${Date.now()}_1`,
                              author_name: "المساعد الذكي (Bot)",
                              is_bot: true,
                              comment_text: "تلميح للحل: استخدم نظرية فيثاغورس كعلاقة أساسية ثم اشتق بالنسبة للزمن t.",
                              likes_count: 32
                            },
                            {
                              id: `cmt_user_${Date.now()}_2`,
                              author_name: "سارة حيدر",
                              comment_text: "الجواب النهائي هو 12 سم مربع / ثانية.",
                              likes_count: 14
                            }
                          ]
                        },
                        {
                          id: `post_sample_${Date.now()}_2`,
                          content: "ملخص قوانين بفر والذوبانية - كيمياء السادس العلمي 2026 كاملة مع الملاحظات النموذجية.",
                          author_display_name: "شبكة طلاب السادس",
                          post_type: "curriculum",
                          likes_count: 142,
                          media_urls: ["https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=600&auto=format&fit=crop&q=80"],
                          comments: [
                            {
                              id: `cmt_user_${Date.now()}_3`,
                              author_name: "أحمد العبيدي",
                              comment_text: "جزاكم الله خيراً، ملخص ممتاز جداً وواضح.",
                              likes_count: 22
                            }
                          ]
                        }
                      ];
                      setRawCommunityJson(JSON.stringify(sample, null, 2));
                    }}
                    className="text-[11px] text-purple-600 hover:text-purple-700 font-bold underline cursor-pointer"
                  >
                    + تجربة نموذج community.json جاهز
                  </button>
                </div>

                <textarea
                  rows={8}
                  value={rawCommunityJson}
                  onChange={(e) => setRawCommunityJson(e.target.value)}
                  placeholder={`ألصق مصفوفة JSON هنا مثل:\n[\n  {\n    "id": "1001",\n    "content": "نص المنشور هنا...",\n    "author_display_name": "اسم الناشر",\n    "media_urls": ["https://..."],\n    "comments": [{ "author_name": "...", "comment_text": "...", "is_bot": true }]\n  }\n]`}
                  className="w-full p-3 font-mono text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500 outline-hidden bg-slate-900 text-slate-100 placeholder:text-slate-500"
                  dir="ltr"
                />
              </div>

              {/* Upload file as JSON */}
              <div className="flex items-center gap-2">
                <label className="flex-1 border-2 border-dashed border-slate-200 hover:border-purple-400 rounded-xl p-3 text-center cursor-pointer bg-slate-50/50 hover:bg-purple-50/30 transition-colors">
                  <UploadCloud className="w-4 h-4 text-purple-600 mx-auto mb-1" />
                  <span className="text-xs font-bold text-slate-700 block">
                    أو اختر ملف community.json من جهازك مباشرة
                  </span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                          const content = event.target?.result as string;
                          setRawCommunityJson(content);
                        };
                        reader.readAsText(file);
                      }
                    }}
                  />
                </label>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setIsCommunityJsonModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
              >
                إغلاق
              </button>

              <button
                type="button"
                disabled={isSubmittingBatch || !rawCommunityJson.trim()}
                onClick={async () => {
                  setBatchError(null);
                  setBatchSuccessMsg(null);
                  setBatchReport(null);
                  try {
                    const parsed = JSON.parse(rawCommunityJson);
                    setIsSubmittingBatch(true);
                    
                    const res = await importCommunityJsonData({
                      posts: Array.isArray(parsed) ? parsed : (parsed.posts || parsed.items || parsed.data || [parsed]),
                      comments: parsed.comments || [],
                      default_group_name: batchTargetGroup,
                      auto_publish: batchAutoApprove,
                    }, sessionToken);

                    setBatchSuccessMsg(res.message);
                    setBatchReport(res.report);
                    await onRefreshData();
                  } catch (err: any) {
                    setBatchError(err.message || 'خطأ أثناء استيراد ملف JSON. تأكد من صحة التنسيق.');
                  } finally {
                    setIsSubmittingBatch(false);
                  }
                }}
                className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-black transition-all shadow-md shadow-purple-600/30 flex items-center gap-1.5 cursor-pointer"
              >
                {isSubmittingBatch ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>جاري التحقق والرفع إلى Supabase B...</span>
                  </>
                ) : (
                  <>
                    <FileJson className="w-3.5 h-3.5" />
                    <span>بدء الاستيراد والحفظ في قاعدة البيانات</span>
                  </>
                )}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 8. ADMIN JWT AUTH SESSION MODAL (إدارة رمز توثيق جلسة المشرف) */}
      {/* ========================================================================= */}
      {isTokenModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            
            <div className="px-6 py-4 bg-gradient-to-r from-slate-900 to-blue-950 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
                  <UserCheck className="w-4 h-4 text-blue-300" />
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-tight">
                    إدارة توثيق المشرف (Admin JWT Session Token)
                  </h3>
                  <p className="text-[11px] text-blue-200">
                    رمز تسجيل الدخول الصادر من Supabase A للتحقق من صلاحيات المشرفين الثلاثة
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsTokenModalOpen(false)}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 leading-relaxed">
                يتم إرسال هذا الرمز تلقائياً في ترويسة <code className="bg-blue-100 px-1 py-0.5 rounded font-mono text-[11px]">Authorization: Bearer [token]</code> مع كل طلب إداري للتحقق من هوية المشرف في جدول <code className="bg-blue-100 px-1 py-0.5 rounded font-mono text-[11px]">dashboard_admins</code> في Supabase B.
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  رمز الجلسة الحالي (JWT Access Token):
                </label>
                <textarea
                  rows={4}
                  value={tempTokenInput}
                  onChange={(e) => setTempTokenInput(e.target.value)}
                  placeholder="ألصق رمز JWT (eyJh...)..."
                  className="w-full p-3 font-mono text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-hidden bg-slate-900 text-slate-100 placeholder:text-slate-500"
                  dir="ltr"
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>الحالة الحالية: {sessionToken ? '✅ مخزن محلياً' : '⚠️ غير مسجل (يتم استخدام الهوية الافتراضية)'}</span>
                {sessionToken && (
                  <button
                    type="button"
                    onClick={() => {
                      setStoredAuthToken('');
                      setSessionToken('');
                      setTempTokenInput('');
                    }}
                    className="text-red-600 hover:text-red-700 font-bold underline cursor-pointer"
                  >
                    مسح الرمز المحفوظ
                  </button>
                )}
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setIsTokenModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
              >
                إلغاء
              </button>

              <button
                type="button"
                onClick={() => {
                  setStoredAuthToken(tempTokenInput.trim());
                  setSessionToken(tempTokenInput.trim());
                  setIsTokenModalOpen(false);
                }}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black transition-all shadow-md shadow-blue-600/30 flex items-center gap-1.5 cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>حفظ الرمز وتفعيل الجلسة</span>
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
