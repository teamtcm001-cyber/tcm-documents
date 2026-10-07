import { createClient } from '@supabase/supabase-js';
import { uploadToDrive, driveFileUrl } from '../utils/googleDrive.js';
import { getLocalName } from '../utils/localIdentity.js';
import {
  todayTH, isIsoDate, isSaneDate, INSANE_DATE_MESSAGE, ALL_STATUSES, CLEARS_BILLED_DATE,
} from '../utils/tracking.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Missing Supabase credentials. Check .env file');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

// ============ AUTH ============
// No login UI — App.jsx signs every visitor into one shared account on load
// so RLS (which requires an authenticated session) keeps working.
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  if (error) throw error;
  return data;
}

export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
}

// Records that someone with this display name opened the app — since every
// visitor shares one Supabase account, this is the only backend record of
// who's actually using the app (until they upload/edit something).
export async function logVisit(displayName) {
  const { error } = await supabase.from('app_visits').insert([{ display_name: displayName }]);
  if (error) console.error('logVisit failed:', error.message);
}

// ============ PROJECTS ============
export async function fetchProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createProject(projectData) {
  const user = await getCurrentUser();
  const { data, error } = await supabase
    .from('projects')
    .insert([{
      ...projectData,
      created_by: user.id
    }])
    .select();
  if (error) throw error;
  return data?.[0];
}

export async function updateProject(projectId, updates) {
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select();
  if (error) throw error;
  return data?.[0];
}

export async function deleteProject(projectId) {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId);
  if (error) throw error;
}

// ============ FILES ============
export async function fetchFiles(projectId) {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchLatestFiles(limit = 10) {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('is_latest', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Postgres text cannot hold NUL, and PostgREST rejects lone UTF-16 surrogates
// ("unsupported Unicode escape sequence"). PDF text extraction can produce both.
export function sanitizePgText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export async function uploadFile(projectId, file, fileType, uploaderName = null, contentText = null) {
  const user = await getCurrentUser();
  contentText = sanitizePgText(contentText);

  // 1. Upload to Google Drive — storage_path stores the Drive file id
  const driveFileId = await uploadToDrive(file);

  // 2. Insert file record (with optional content_text for search)
  const baseName = file.name.replace(/\.\w+$/, '').replace(/_(rev\s*\d+|v\d+|\d{4}-\d{2}-\d{2})$/i, '');
  const ext = file.name.split('.').pop();

  const insertData = {
    project_id: projectId,
    name: file.name,
    type: fileType,
    base_name: baseName,
    size: Math.round(file.size / 1024),
    ext: ext,
    storage_path: driveFileId,
    uploader_id: user.id,
    uploader_name: uploaderName || null,
    is_latest: true
  };
  if (contentText) {
    insertData.content_text = contentText;
  }

  const { data: fileData, error: fileError } = await supabase
    .from('files')
    .insert([insertData])
    .select();

  if (fileError) {
    // If content_text column doesn't exist yet, retry without it
    if (contentText && /content_text/i.test(fileError.message || '')) {
      delete insertData.content_text;
      const retry = await supabase.from('files').insert([insertData]).select();
      if (retry.error) throw retry.error;
      return retry.data?.[0];
    }
    throw fileError;
  }

  // 3. Mark old versions as not latest
  await supabase
    .from('files')
    .update({ is_latest: false })
    .eq('base_name', baseName)
    .eq('project_id', projectId)
    .neq('id', fileData[0].id);

  return fileData?.[0];
}

// Update content_text for existing file (used for reindexing)
export async function updateFileContent(fileId, contentText) {
  const { error } = await supabase
    .from('files')
    .update({ content_text: sanitizePgText(contentText) })
    .eq('id', fileId);
  if (error && !/content_text/i.test(error.message || '')) throw error;
  return !error;
}

// Get file blob from storage (for reindexing)
export async function getFileBlob(storagePath) {
  const res = await fetch(driveFileUrl(storagePath));
  if (!res.ok) throw new Error('ไม่สามารถอ่านไฟล์จาก Google Drive ได้');
  return res.blob();
}

// Get URL for a file (used by Preview) — proxied through /api/drive-file
export function getFilePublicUrl(storagePath) {
  if (!storagePath) return '';
  return driveFileUrl(storagePath);
}

// Kept for API compatibility — Drive proxy URL is already access-controlled server-side
export async function getFileSignedUrl(storagePath) {
  return getFilePublicUrl(storagePath);
}

export async function deleteFile(fileId) {
  const { error } = await supabase
    .from('files')
    .delete()
    .eq('id', fileId);
  if (error) throw error;
}

export async function downloadFile(fileId, fileName) {
  const { data, error } = await supabase
    .from('files')
    .select('storage_path')
    .eq('id', fileId)
    .single();

  if (error) throw error;

  // Trigger download via the Drive proxy endpoint
  const url = driveFileUrl(data.storage_path, { download: true, name: fileName });
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'file';
  a.click();
}

// ============ ACTIVITY/TIMELINE ============
export async function fetchActivity(projectId, limit = 6) {
  const { data, error } = await supabase
    .from('activity')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function logActivity(projectId, action, details, fileId = null, { anonymous = false } = {}) {
  const user = await getCurrentUser();
  const { error } = await supabase
    .from('activity')
    .insert([{
      project_id: projectId,
      action,
      details,
      file_id: fileId,
      user_id: user.id,
      user_name: anonymous ? null : getLocalName() || user.user_metadata?.full_name || user.email
    }]);
  if (error) throw error;
}

// ============ STATS ============
export async function fetchStats() {
  const [projectsData, filesData] = await Promise.all([
    supabase.from('projects').select('id', { count: 'exact' }),
    supabase.from('files').select('id', { count: 'exact' })
  ]);

  return {
    projects: projectsData.count || 0,
    files: filesData.count || 0,
    types: 8 // Fixed for now
  };
}

// ============ PROJECT TRACKING ============
// Backed by scripts/project-tracking.sql (the contract). The tables may not be
// installed yet, so:
//   * READ functions never throw. They resolve to
//       { data, notInstalled, error }
//     where notInstalled === true means the tracking schema is missing and the
//     UI should show TRACKING_NOT_INSTALLED_MESSAGE instead of data.
//   * WRITE functions throw an Error whose message is already Thai and safe to
//     toast; err.notInstalled === true when the schema is missing.
// Nothing here is enforced per person: updated_by / attached_by / project_co
// are self-reported display names (see the SECURITY note in the SQL file).

export const TRACKING_NOT_INSTALLED_MESSAGE =
  'ยังไม่ได้ติดตั้งโครงสร้างข้อมูลติดตามงาน — ให้ผู้ดูแลรัน scripts/project-tracking.sql ใน Supabase SQL Editor';

// Postgres: 42P01 undefined_table, 42703 undefined_column, 42883 undefined_function
// PostgREST: PGRST200 (no such relationship), PGRST204 (column not in cache), PGRST205 (table/view not in cache)
export function isTrackingNotInstalled(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (['42P01', '42703', '42883', 'PGRST200', 'PGRST204', 'PGRST205'].includes(code)) return true;
  return /does not exist|could not find the (table|function|relationship|'[^']+' column)|schema cache/i.test(
    error.message || ''
  );
}

async function trackingRead(run) {
  try {
    const { data, error, partial } = await run();
    if (error) return { data: null, notInstalled: isTrackingNotInstalled(error), error };
    return { data, notInstalled: false, error: null, partial: !!partial };
  } catch (error) {
    return { data: null, notInstalled: isTrackingNotInstalled(error), error };
  }
}

// Turn a Supabase/Postgres error into an Error with a Thai message.
function trackingWriteError(error, fallback = 'บันทึกไม่สำเร็จ') {
  if (isTrackingNotInstalled(error)) {
    const e = new Error(TRACKING_NOT_INSTALLED_MESSAGE);
    e.notInstalled = true;
    return e;
  }
  const msg = error?.message || '';
  let text;
  if (error?.code === '23505') {
    text = /unique_label/.test(msg)
      ? 'มีรายการชื่อนี้ในเช็กลิสต์อยู่แล้ว'
      : 'ข้อมูลซ้ำกับที่มีอยู่แล้ว (มีคนอื่นเพิ่มพร้อมกัน ลองใหม่อีกครั้ง)';
  } else if (error?.code === '23514') {
    text = /projects_period_chk/.test(msg)
      ? 'วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มสัญญา'
      : /does not belong to project/.test(msg)
        ? 'ไฟล์นี้ไม่ได้อยู่ในโครงการเดียวกับงวดงานนี้'
        : `${fallback}: ข้อมูลไม่ผ่านเงื่อนไขของระบบ`;
  } else if (error?.code === '42501') {
    text = `${fallback}: ไม่มีสิทธิ์เขียนข้อมูลนี้ (ตรวจสอบว่ารัน scripts/project-tracking.sql ครบแล้ว)`;
  } else {
    text = `${fallback}: ${msg || 'ไม่ทราบสาเหตุ'}`;
  }
  const e = new Error(text);
  e.cause = error;
  return e;
}

// Validate a user-supplied date: real yyyy-mm-dd, and a plausible (Gregorian) year.
function assertDate(v, formatMessage = 'รูปแบบวันที่ไม่ถูกต้อง') {
  if (!isIsoDate(v)) throw new Error(formatMessage);
  if (!isSaneDate(v)) throw new Error(INSANE_DATE_MESSAGE);
}

// Tracking writes deliberately do NOT record who made the change (user decision).
// progress_updates.updated_by is NOT NULL with a non-empty check in the live DB,
// so it gets this placeholder; every other recorder column is simply null.
// The UI treats '-' / '' / null as "no name" and never displays it.
const NO_RECORDER = '-';

// An UPDATE that RLS filters out succeeds with 0 rows. Surface that as an error.
function expectRows(data, message) {
  if (!data || data.length === 0) {
    throw new Error(message || 'บันทึกไม่สำเร็จ: ไม่มีแถวข้อมูลถูกแก้ไข (อาจไม่มีสิทธิ์ หรือรายการถูกลบไปแล้ว)');
  }
  return data[0];
}

// UPDATE/DELETE on installments (delete) and progress_updates (edit/delete) only
// have RLS policies after scripts/project-tracking-fix-2.sql has been run. Before
// that, Postgres answers 42501 or RLS silently matches 0 rows; both mean the same
// thing to the user: ask the admin to run fix-2.
function fix2Message(verb) {
  return `${verb}ไม่สำเร็จ — ผู้ดูแลต้องรัน scripts/project-tracking-fix-2.sql ใน Supabase SQL Editor ก่อน`;
}
function isPermissionError(error) {
  return String(error?.code || '') === '42501' || /permission denied|row-level security/i.test(error?.message || '');
}
// Run on the { data, error } of a write that needs fix-2. Throws a Thai Error, else returns the first row.
function expectFix2Rows({ data, error }, verb) {
  if (error) {
    if (isPermissionError(error)) throw new Error(fix2Message(verb));
    throw trackingWriteError(error, `${verb}ไม่สำเร็จ`);
  }
  return expectRows(data, `${fix2Message(verb)} (หากรันแล้ว ให้รีเฟรชหน้า — รายการอาจถูกลบไปแล้ว)`);
}

// ---- reads: overview / progress ----

// ONE query to project_tracking_overview for the cross-project view.
// The overview view has no "days in status", which the amber rule
// "ready_to_bill for > 7 days" needs, so a tiny best-effort second query on
// installment_summary adds `ready_to_bill_days` per project (null if none).
// If that second query fails the main data is still returned, but with
// `partial: true` so the UI can warn that the health status may be incomplete
// (the aging rule cannot fire without it).
export function fetchTrackingOverview() {
  return trackingRead(async () => {
    const main = await supabase
      .from('project_tracking_overview')
      .select('*')
      .order('project_code', { ascending: true });
    if (main.error) return main;

    const aging = await supabase
      .from('installment_summary')
      .select('project_id, days_in_status')
      .eq('status', 'ready_to_bill');
    const maxDays = {};
    if (aging.error) {
      console.warn('fetchTrackingOverview: aging query failed:', aging.error.message);
    } else {
      for (const r of aging.data || []) {
        const d = r.days_in_status ?? 0;
        if (maxDays[r.project_id] === undefined || d > maxDays[r.project_id]) maxDays[r.project_id] = d;
      }
    }
    return {
      data: (main.data || []).map((r) => ({ ...r, ready_to_bill_days: maxDays[r.project_id] ?? null })),
      error: null,
      partial: !!aging.error,
    };
  });
}

// Single project's overview row (for the detail header). data = row | null
export function fetchProjectTrackingRow(projectId) {
  return trackingRead(() =>
    supabase.from('project_tracking_overview').select('*').eq('project_id', projectId).maybeSingle()
  );
}

// Newest first. Entries can be corrected or deleted (needs scripts/project-tracking-fix-2.sql).
export function fetchProgressHistory(projectId) {
  return trackingRead(() =>
    supabase
      .from('progress_updates')
      .select('*')
      .eq('project_id', projectId)
      .order('as_of', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
  );
}

// { percent: whole number 0-100, asOf: 'yyyy-mm-dd' (default today TH, not in the future), note? }
function validateProgressInput({ percent, asOf, note }) {
  if (percent === '' || percent == null) throw new Error('กรุณากรอก % ความคืบหน้า');
  const n = Number(percent);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('% ความคืบหน้าต้องเป็นจำนวนเต็ม 0–100 (ไม่มีทศนิยม)');
  const today = todayTH();
  const date = asOf || today;
  assertDate(date);
  if (date > today) throw new Error('วันที่ข้อมูลต้องไม่เกินวันนี้');
  return { percent_complete: n, as_of: date, note: (note || '').trim() || null };
}

export async function addProgressUpdate(projectId, input = {}) {
  const fields = validateProgressInput(input);
  const updated_by = NO_RECORDER;
  const { data, error } = await supabase
    .from('progress_updates')
    .insert([{ project_id: projectId, ...fields, updated_by }])
    .select();
  if (error) throw trackingWriteError(error, 'บันทึก % ไม่สำเร็จ');
  return expectRows(data);
}

// Correct an existing entry (same validation as adding). Needs fix-2 (UPDATE policy).
// updated_by is deliberately left untouched: no names are recorded.
export async function updateProgressUpdate(id, input = {}) {
  const fields = validateProgressInput(input);
  const res = await supabase.from('progress_updates').update(fields).eq('id', id).select();
  return expectFix2Rows(res, 'แก้ไขรายการ');
}

// Needs fix-2 (DELETE policy).
export async function deleteProgressUpdate(id) {
  const res = await supabase.from('progress_updates').delete().eq('id', id).select();
  expectFix2Rows(res, 'ลบรายการ');
}

// ---- installments ----

// installment_summary rows for one project, ordered by installment_no
export function fetchInstallments(projectId) {
  return trackingRead(() =>
    supabase
      .from('installment_summary')
      .select('*')
      .eq('project_id', projectId)
      .order('installment_no', { ascending: true })
  );
}

// installment_no = max + 1 (cancelled ones count, the number is never reused).
// The trigger writes the creation event and copies the checklist template.
export async function createInstallment(projectId, { title, plannedBillDate, note } = {}) {
  if (plannedBillDate) assertDate(plannedBillDate);
  const updated_by = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await supabase
      .from('project_installments')
      .select('installment_no')
      .eq('project_id', projectId)
      .order('installment_no', { ascending: false })
      .limit(1);
    if (last.error) throw trackingWriteError(last.error, 'เพิ่มงวดไม่สำเร็จ');
    const installment_no = (last.data?.[0]?.installment_no || 0) + 1;
    const { data, error } = await supabase
      .from('project_installments')
      .insert([{
        project_id: projectId,
        installment_no,
        title: (title || '').trim() || null,
        planned_bill_date: plannedBillDate || null,
        note: (note || '').trim() || null,
        status: 'planned',
        updated_by,
      }])
      .select();
    if (!error) return expectRows(data);
    // two coordinators added at once -> unique(project_id, installment_no); recompute and retry
    if (error.code === '23505' && attempt < 2) continue;
    throw trackingWriteError(error, 'เพิ่มงวดไม่สำเร็จ');
  }
}

// changes: any of { installmentNo, title, plannedBillDate, note }. Does not touch status.
export async function updateInstallment(installmentId, changes = {}) {
  const patch = { updated_by: null };
  if ('installmentNo' in changes) {
    const n = Number(changes.installmentNo);
    if (changes.installmentNo === '' || changes.installmentNo == null || !Number.isInteger(n) || n < 1) {
      throw new Error('งวดที่ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
    }
    patch.installment_no = n;
  }
  if ('title' in changes) patch.title = (changes.title || '').trim() || null;
  if ('note' in changes) patch.note = (changes.note || '').trim() || null;
  if ('plannedBillDate' in changes) {
    if (changes.plannedBillDate) assertDate(changes.plannedBillDate);
    patch.planned_bill_date = changes.plannedBillDate || null;
  }
  const { data, error } = await supabase
    .from('project_installments')
    .update(patch)
    .eq('id', installmentId)
    .select();
  if (error) {
    // unique(project_id, installment_no)
    if (error.code === '23505' && 'installmentNo' in changes) throw new Error(`มีงวดที่ ${changes.installmentNo} อยู่แล้ว`);
    throw trackingWriteError(error, 'แก้ไขงวดไม่สำเร็จ');
  }
  return expectRows(data);
}

// Permanently deletes the installment; its checklist rows go with it (FK cascade).
// The files themselves are not touched. Needs the DELETE policy from fix-2.
export async function deleteInstallment(installmentId) {
  const res = await supabase.from('project_installments').delete().eq('id', installmentId).select();
  expectFix2Rows(res, 'ลบ');
}

// Status + status_note (+ billed_date) in ONE update. Saving the SAME status is
// allowed and simply persists the note / billed date. Any status is allowed (the
// DB does not restrict transitions); the caller confirms backward moves.
// status_note is the installment's persistent "หมายเหตุสถานะ" (there is no
// status history any more). billed_date is not maintained by a trigger, so it is
// set here: the given date (default today) when the status is 'billed', cleared
// for a pre-billing status or cancel, otherwise left as is.
export async function setInstallmentStatus(installmentId, status, note, { billedDate } = {}) {
  if (!ALL_STATUSES.includes(status)) throw new Error('สถานะไม่ถูกต้อง');
  const patch = { status, status_note: (note || '').trim() || null, updated_by: null };
  if (status === 'billed') {
    const today = todayTH();
    const d = billedDate || today;
    assertDate(d, 'รูปแบบวันที่เบิกไม่ถูกต้อง');
    if (d > today) throw new Error('วันที่เบิกต้องไม่เกินวันนี้');
    patch.billed_date = d;
  } else if (CLEARS_BILLED_DATE.includes(status)) {
    patch.billed_date = null;
  }
  const { data, error } = await supabase
    .from('project_installments')
    .update(patch)
    .eq('id', installmentId)
    .select();
  if (error) throw trackingWriteError(error, 'เปลี่ยนสถานะไม่สำเร็จ');
  return expectRows(data);
}

// ---- checklist (installment_documents) ----

// Rows + embedded file (name/ext/version info). file === null when nothing is attached.
// file.is_latest === false means a newer version of that document exists.
export function fetchChecklist(installmentId) {
  return trackingRead(() =>
    supabase
      .from('installment_documents')
      .select('*, file:files(id, project_id, name, ext, type, base_name, size, is_latest, created_at, storage_path)')
      .eq('installment_id', installmentId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
}

export async function addChecklistItem(installmentId, projectId, { label, required = true } = {}) {
  const text = (label || '').trim();
  if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
  const last = await supabase
    .from('installment_documents')
    .select('sort_order')
    .eq('installment_id', installmentId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (last.error) throw trackingWriteError(last.error, 'เพิ่มรายการไม่สำเร็จ');
  const sort_order = (last.data?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await supabase
    .from('installment_documents')
    .insert([{ installment_id: installmentId, project_id: projectId, label: text, required: !!required, sort_order }])
    .select();
  if (error) throw trackingWriteError(error, 'เพิ่มรายการไม่สำเร็จ');
  return expectRows(data);
}

// changes: { required?, label? }
export async function updateChecklistItem(itemId, changes = {}) {
  const patch = {};
  if ('required' in changes) patch.required = !!changes.required;
  if ('label' in changes) {
    const text = (changes.label || '').trim();
    if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
    patch.label = text;
  }
  const { data, error } = await supabase.from('installment_documents').update(patch).eq('id', itemId).select();
  if (error) throw trackingWriteError(error, 'แก้ไขรายการไม่สำเร็จ');
  return expectRows(data);
}

export async function removeChecklistItem(itemId) {
  const { data, error } = await supabase.from('installment_documents').delete().eq('id', itemId).select();
  if (error) throw trackingWriteError(error, 'ลบรายการไม่สำเร็จ');
  expectRows(data, 'ลบไม่สำเร็จ: ไม่พบรายการ หรือไม่มีสิทธิ์ลบ');
}

// file_id + attached_by in ONE update (the trigger checks the file is in the
// same project and stamps attached_at).
export async function attachFileToChecklistItem(itemId, fileId) {
  const attached_by = null;
  const { data, error } = await supabase
    .from('installment_documents')
    .update({ file_id: fileId, attached_by })
    .eq('id', itemId)
    .select();
  if (error) throw trackingWriteError(error, 'แนบไฟล์ไม่สำเร็จ');
  return expectRows(data);
}

export async function detachFileFromChecklistItem(itemId) {
  const { data, error } = await supabase
    .from('installment_documents')
    .update({ file_id: null })
    .eq('id', itemId)
    .select();
  if (error) throw trackingWriteError(error, 'ถอดไฟล์ไม่สำเร็จ');
  return expectRows(data);
}

// Newest version (is_latest = true) sharing the project + base_name of `file`
// (same grouping rule uploadFile uses). data = files row | null.
export function fetchLatestVersionOfFile(file) {
  return trackingRead(() =>
    supabase
      .from('files')
      .select('*')
      .eq('project_id', file.project_id)
      .eq('base_name', file.base_name)
      .eq('is_latest', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

// ---- per-project checklist template (auto-copied into each NEW installment) ----

export function fetchChecklistTemplate(projectId) {
  return trackingRead(() =>
    supabase
      .from('project_checklist_templates')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
}

export async function addChecklistTemplateItem(projectId, { label, required = true } = {}) {
  const text = (label || '').trim();
  if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
  const last = await supabase
    .from('project_checklist_templates')
    .select('sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (last.error) throw trackingWriteError(last.error, 'เพิ่มรายการแม่แบบไม่สำเร็จ');
  const sort_order = (last.data?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await supabase
    .from('project_checklist_templates')
    .insert([{ project_id: projectId, label: text, required: !!required, sort_order }])
    .select();
  if (error) throw trackingWriteError(error, 'เพิ่มรายการแม่แบบไม่สำเร็จ');
  return expectRows(data);
}

export async function removeChecklistTemplateItem(templateItemId) {
  const { data, error } = await supabase
    .from('project_checklist_templates')
    .delete()
    .eq('id', templateItemId)
    .select();
  if (error) throw trackingWriteError(error, 'ลบรายการแม่แบบไม่สำเร็จ');
  expectRows(data, 'ลบไม่สำเร็จ: ไม่พบรายการ หรือไม่มีสิทธิ์ลบ');
}

// For installments created before the template existed: copy template rows
// whose label is not already on the installment. Returns how many were added.
export async function applyChecklistTemplate(installmentId, projectId) {
  const tpl = await supabase
    .from('project_checklist_templates')
    .select('label, required, sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (tpl.error) throw trackingWriteError(tpl.error, 'ใช้แม่แบบไม่สำเร็จ');
  const existing = await supabase.from('installment_documents').select('label, sort_order').eq('installment_id', installmentId);
  if (existing.error) throw trackingWriteError(existing.error, 'ใช้แม่แบบไม่สำเร็จ');
  const have = new Set((existing.data || []).map((r) => r.label));
  let next = Math.max(-1, ...(existing.data || []).map((r) => r.sort_order ?? 0)) + 1;
  const rows = (tpl.data || [])
    .filter((t) => !have.has(t.label))
    .map((t) => ({ installment_id: installmentId, project_id: projectId, label: t.label, required: t.required, sort_order: next++ }));
  if (rows.length === 0) return 0;
  const { error } = await supabase.from('installment_documents').insert(rows);
  if (error) throw trackingWriteError(error, 'ใช้แม่แบบไม่สำเร็จ');
  return rows.length;
}

// ---- project: contract period + coordinator ----

// updates: { start_date, end_date, project_co }. Reuses updateProject, then
// verifies a row actually came back: without an UPDATE policy on `projects`
// the call "succeeds" with 0 rows, which would otherwise look like a save.
export async function updateProjectTracking(projectId, updates = {}) {
  const start = updates.start_date || null;
  const end = updates.end_date || null;
  if (start) assertDate(start, 'รูปแบบวันเริ่มสัญญาไม่ถูกต้อง');
  if (end) assertDate(end, 'รูปแบบวันสิ้นสุดสัญญาไม่ถูกต้อง');
  if (start && end && end < start) throw new Error('วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มสัญญา');
  const project_co = (updates.project_co || '').trim() || null;

  let row;
  try {
    row = await updateProject(projectId, { start_date: start, end_date: end, project_co });
  } catch (err) {
    throw trackingWriteError(err, 'บันทึกข้อมูลโครงการไม่สำเร็จ');
  }
  if (!row) {
    throw new Error(
      'บันทึกไม่สำเร็จ: ระบบไม่ได้แก้ไขข้อมูลโครงการ (ตาราง projects อาจยังไม่อนุญาตให้แก้ไข — แจ้งผู้ดูแลตรวจ policy UPDATE)'
    );
  }
  // audit trail in the existing activity log; failure here must not fail the save
  try {
    await logActivity(
      projectId,
      'tracking_update',
      `แก้ไขข้อมูลติดตามงาน: Project Co=${project_co || '-'}, สัญญา ${start || '-'} ถึง ${end || '-'}`,
      null,
      { anonymous: true }
    );
  } catch (err) {
    console.warn('logActivity (tracking_update) failed:', err?.message);
  }
  return row;
}
