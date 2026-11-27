// Enhanced AI Search Engine — Smart natural language understanding
// for Thai + English file/project queries

import { TYPE_LABEL } from './format.js'

// Synonym dictionary
const SYNONYMS = {
  // File/Document
  เอกสาร: ['ไฟล์', 'document', 'file', 'doc', 'เอกสาร'],
  ค้นหา: ['หา', 'find', 'search', 'look', 'ค้น', 'เอา', 'ขอ', 'อยากได้', 'ต้องการ', 'ส่ง', 'เปิด', 'show', 'get'],
  ดาวน์โหลด: ['download', 'โหลด', 'เซฟ', 'save', 'ดล', 'ดาว'],
  ล่าสุด: ['ใหม่ที่สุด', 'อัพเดทล่าสุด', 'latest', 'newest', 'most recent', 'last', 'recent'],
  ทั้งหมด: ['ทุกตัว', 'ทุกไฟล์', 'all', 'every', 'everything', 'ทุก'],
  // Time
  วันนี้: ['today', 'วันนี้'],
  เมื่อวาน: ['yesterday', 'เมื่อวาน', 'เมื่อวานนี้'],
  อาทิตย์: ['สัปดาห์', 'week', 'อาทิตย์', '7 วัน', 'เจ็ดวัน'],
  เดือน: ['month', 'เดือน'],
  ปี: ['year', 'ปี'],
}

// Time pattern parser
function parseTimeRange(text) {
  const t = text.toLowerCase()
  const now = Date.now()
  const day = 86400000

  // Today
  if (/(วันนี้|today)/i.test(t)) {
    return { from: new Date().setHours(0, 0, 0, 0), label: 'วันนี้' }
  }
  // Yesterday
  if (/(เมื่อวาน|yesterday)/i.test(t)) {
    const start = new Date()
    start.setDate(start.getDate() - 1)
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    end.setDate(end.getDate() - 1)
    end.setHours(23, 59, 59, 999)
    return { from: start.getTime(), to: end.getTime(), label: 'เมื่อวาน' }
  }
  // X days ago / last N days
  const dayMatch = t.match(/(\d+)\s*(วัน|days?)/i)
  if (dayMatch) {
    const n = parseInt(dayMatch[1])
    return { from: now - n * day, label: `${n} วันที่ผ่านมา` }
  }
  // This week / 1 week / last week
  if (/(อาทิตย์|สัปดาห์|week)/i.test(t)) {
    if (/(ที่แล้ว|last)/i.test(t)) {
      return { from: now - 14 * day, to: now - 7 * day, label: 'สัปดาห์ที่แล้ว' }
    }
    return { from: now - 7 * day, label: 'สัปดาห์นี้' }
  }
  // This month / 1 month
  if (/(เดือนนี้|this month)/i.test(t)) {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime(), label: 'เดือนนี้' }
  }
  if (/(เดือน|month)/i.test(t)) {
    return { from: now - 30 * day, label: '30 วันที่ผ่านมา' }
  }
  // Year
  if (/(ปีนี้|this year)/i.test(t)) {
    const start = new Date(new Date().getFullYear(), 0, 1)
    return { from: start.getTime(), label: 'ปีนี้' }
  }
  return null
}

// Size pattern parser
function parseSizeFilter(text) {
  const t = text.toLowerCase()
  // Bigger than X MB/KB
  const biggerMatch = t.match(/(ใหญ่กว่า|เกิน|มากกว่า|>|bigger than|more than|over)\s*(\d+(?:\.\d+)?)\s*(mb|kb|gb)/i)
  if (biggerMatch) {
    const n = parseFloat(biggerMatch[2])
    const unit = biggerMatch[3].toLowerCase()
    const kb = unit === 'mb' ? n * 1024 : unit === 'gb' ? n * 1024 * 1024 : n
    return { min: kb, label: `> ${n}${unit.toUpperCase()}` }
  }
  // Smaller than
  const smallerMatch = t.match(/(เล็กกว่า|น้อยกว่า|ต่ำกว่า|<|smaller than|less than|under)\s*(\d+(?:\.\d+)?)\s*(mb|kb|gb)/i)
  if (smallerMatch) {
    const n = parseFloat(smallerMatch[2])
    const unit = smallerMatch[3].toLowerCase()
    const kb = unit === 'mb' ? n * 1024 : unit === 'gb' ? n * 1024 * 1024 : n
    return { max: kb, label: `< ${n}${unit.toUpperCase()}` }
  }
  // Biggest / smallest
  if (/ใหญ่ที่สุด|biggest|largest/i.test(t)) {
    return { sort: 'desc', label: 'ใหญ่ที่สุด' }
  }
  if (/เล็กที่สุด|smallest/i.test(t)) {
    return { sort: 'asc', label: 'เล็กที่สุด' }
  }
  return null
}

// Uploader pattern parser
function parseUploader(text, knownUploaders) {
  // ที่ X อัพ / ของ X / โดย X
  const patterns = [/(?:ที่|โดย|by|from)\s+([฀-๿a-zA-Z0-9_.@-]+)\s*(?:อัพ|upload|ส่ง)?/i, /uploader\s*[:=]\s*([฀-๿a-zA-Z0-9_.@-]+)/i]
  for (const re of patterns) {
    const m = text.match(re)
    if (m && m[1]) {
      const needle = m[1].toLowerCase()
      const found = knownUploaders.find((u) => u && u.toLowerCase().includes(needle))
      if (found) return { name: found, label: `โดย ${found}` }
    }
  }
  // Search known uploaders directly in text
  const lower = text.toLowerCase()
  for (const u of knownUploaders) {
    if (u && u.length >= 3 && lower.includes(u.toLowerCase())) {
      return { name: u, label: `โดย ${u}` }
    }
  }
  return null
}

// Fuzzy match score (returns 0-1)
function fuzzyScore(needle, haystack) {
  if (!needle || !haystack) return 0
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  if (h === n) return 1
  if (h.includes(n)) return 0.85
  // Token match
  const tokens = n.split(/[\s_-]+/).filter((t) => t.length >= 2)
  if (tokens.length === 0) return 0
  let matched = 0
  for (const tok of tokens) {
    if (h.includes(tok)) matched++
  }
  return matched / tokens.length
}

// Match project from text
function matchProject(text, projects) {
  const t = text.toLowerCase()
  // Sort by code length descending (more specific first)
  const sorted = [...projects].sort((a, b) => (b.code || '').length - (a.code || '').length)

  // Pass 1: Exact code match
  for (const p of sorted) {
    const code = (p.code || '').toLowerCase()
    if (code && t.includes(code)) return { project: p, score: 1, matchType: 'code' }
  }
  // Pass 2: Code root (before dash)
  for (const p of sorted) {
    const code = (p.code || '').toLowerCase()
    if (code && code.includes('-')) {
      const root = code.split('-')[0]
      if (root.length >= 2 && t.includes(root)) return { project: p, score: 0.9, matchType: 'code-root' }
    }
  }
  // Pass 3: Name word match
  for (const p of projects) {
    const name = (p.name || '').toLowerCase()
    const words = name.split(/[\s,]+/).filter((w) => w.length >= 3)
    for (const word of words) {
      if (t.includes(word)) return { project: p, score: 0.7, matchType: 'name' }
    }
  }
  // Pass 4: Fuzzy any keyword
  let best = null
  for (const p of projects) {
    const nameScore = fuzzyScore(t, p.name || '')
    const codeScore = fuzzyScore(t, p.code || '')
    const score = Math.max(nameScore, codeScore)
    if (score > 0.5 && (!best || score > best.score)) {
      best = { project: p, score, matchType: 'fuzzy' }
    }
  }
  return best
}

// Match type from text
function matchType(text) {
  const t = text.toLowerCase()
  // Sort by label length desc for specificity
  const entries = Object.entries(TYPE_LABEL).sort((a, b) => b[1].length - a[1].length)
  for (const [key, label] of entries) {
    if (t.includes(key) || t.includes(label.toLowerCase())) {
      return { type: key, label }
    }
  }
  // Common aliases
  const aliases = {
    eia: ['สิ่งแวดล้อม', 'environment', 'อีไอเอ'],
    drawing: ['แปลน', 'plan', 'dwg', 'cad', 'blueprint'],
    contract: ['agreement', 'mou', 'tor'],
    boq: ['ราคา', 'cost', 'งบ', 'ประมาณ', 'budget'],
    mom: ['minutes', 'ประชุม', 'meeting'],
    standard: ['มยผ', 'spec', 'tis'],
    labor: ['safety', 'ปลอดภัย', 'แรงงาน'],
  }
  for (const [key, words] of Object.entries(aliases)) {
    for (const w of words) {
      if (t.includes(w)) return { type: key, label: TYPE_LABEL[key] }
    }
  }
  return null
}

// Parse "content contains" query — works with Thai (no-space) and English
// Returns { keyword, label } or null
function parseContentQuery(text) {
  // Words after these verbs/markers = content keyword
  // STOP words: ของ, ใน, จาก, สำหรับ, ที่อยู่, in project, of project
  // Note: \s* allows optional space (Thai often has no spaces between words)
  const patterns = [
    // "พูดถึง[เรื่อง] X" / "กล่าวถึง[เรื่อง] X" / "อ้างถึง X"
    /(?:พูดถึง|กล่าวถึง|อ้างอิงถึง|อ้างถึง|พูดเรื่อง|กล่าวเรื่อง|ระบุถึง|กล่าวว่า|พูดว่า)\s*(?:เรื่อง\s*)?(.+?)(?:\s*(?:ของโครงการ|ในโครงการ|ของ\s|ใน\s|จาก\s|สำหรับ\s|ที่อยู่|in project|of project)|$|[,.?!\n])/i,
    // English "mention X" / "talk about X" / "discuss X"
    /(?:mention(?:ed|s|ing)?|talk(?:s|ing|ed)?\s+about|discuss(?:es|ed|ing)?|reference[ds]?)\s+(.+?)(?:\s+(?:of|in|from|for)\s+|$|[,.?!\n])/i,
    // "มีคำว่า X" / "มีข้อความ X"
    /(?:มีคำว่า|มีข้อความ|มีเนื้อหา.*?ว่า|มี keyword|contains?|with keyword|with text)\s*["']?(.+?)["']?(?:\s*(?:ของโครงการ|ในโครงการ|ของ\s|ใน\s)|$|[,.?!\n])/i,
    // "เกี่ยวกับ X" — must not match "เกี่ยวกับโครงการ"
    /(?:เกี่ยวกับ|เรื่อง(?!ของ))\s*(.+?)(?:\s*(?:ของโครงการ|ในโครงการ|ของ\s|ใน\s|จาก\s)|$|[,.?!\n])/i,
  ]

  for (const re of patterns) {
    const m = text.match(re)
    if (m && m[1]) {
      let keyword = m[1].trim().replace(/^["']|["']$/g, '').trim()
      // Strip leading noise words
      keyword = keyword.replace(/^(?:เรื่อง|การ)\s*/, '').trim()
      // Strip trailing project codes (so "F1 ของโครงการ ABCD" → "F1")
      keyword = keyword.replace(/\s+(?:โครงการ|project)\s*[a-zA-Z0-9_-]+\s*$/i, '').trim()
      // Validate
      if (keyword.length >= 2 && keyword.length <= 100) {
        return { keyword, label: `เนื้อหามี "${keyword}"` }
      }
    }
  }
  return null
}

// Detect intent — order matters! More specific first
function detectIntent(text) {
  const t = text.toLowerCase().trim()

  // 1. Greeting (exact start match)
  if (/^(สวัสดี|หวัดดี|hello|hi|hey|help|ช่วย|วิธีใช้|how to use)/i.test(t)) return 'greeting'

  // 2. Count — any occurrence of "กี่" / "จำนวน" / "how many"
  //    e.g., "MOM กี่ฉบับ", "ในโครงการ ABCD มี MOM กี่ฉบับ", "นับให้หน่อย"
  if (/(กี่[ฉ่ี]?[บั]?[บ]?|จำนวน|how many|count|มีกี่|นับ)/i.test(t)) return 'count'

  // 3. Stats — explicit summary keywords
  if (/(สถิติ|stat|summary|สรุป|รายงานรวม|overview|breakdown|รวมทั้งระบบ)/i.test(t)) return 'stats'

  // 4. List projects — must be explicit, not just "โครงการ" + "มี"
  if (/(มีโครงการอะไรบ้าง|รายชื่อโครงการ|รายการโครงการ|โครงการทั้งหมด|list (all )?projects?|all projects)/i.test(t)) return 'list_projects'

  // 5. ZIP — explicit zip / download all
  if (/(zip|รวมไฟล์|รวม.*?(โครงการ|ทั้งหมด)|ดาวน์โหลดทั้ง|download all|zip ทั้ง)/i.test(t)) return 'zip'

  // 6. Who uploaded
  if (/(ใครอัพ|ใครเป็นคน|who uploaded|คนอัพ|ผู้อัพ)/i.test(t)) return 'who'

  // 7. When
  if (/(เมื่อไหร่|เมื่อไร|when (was|did|is)|ล่าสุดเมื่อ|วันที่.*อัพ)/i.test(t)) return 'when'

  // Default: find/list files
  return 'find'
}

/**
 * Main search engine
 * @param {string} text - User query
 * @param {object} ctx - { projects, files }
 * @returns {object} { intent, reply, files, projectCode, summary }
 */
export function searchFiles(text, ctx) {
  const { projects = [], files = [] } = ctx
  if (!text?.trim()) return { intent: 'answer', reply: 'กรุณาพิมพ์คำถามครับ' }

  const intent = detectIntent(text)

  // Greeting
  if (intent === 'greeting') {
    return {
      intent: 'answer',
      reply:
        `สวัสดีครับ! ระบบมี ${projects.length} โครงการ ${files.length} ไฟล์\n\n` +
        `ลองถามได้หลากหลายแบบ:\n` +
        `• "หา BOQ ล่าสุดของ ABC"\n` +
        `• "แบบทั้งหมดในโครงการ MRT"\n` +
        `• "ไฟล์ที่อัพโหลดเมื่อวาน"\n` +
        `• "เอกสารใหญ่กว่า 5MB"\n` +
        `• "ของที่นภัสวรรณอัพ"\n` +
        `• "มีโครงการอะไรบ้าง"\n` +
        `• "MOM กี่ฉบับ"`,
    }
  }

  // List projects
  if (intent === 'list_projects') {
    if (projects.length === 0) {
      return { intent: 'answer', reply: 'ยังไม่มีโครงการในระบบครับ' }
    }
    const list = projects
      .map((p) => {
        const cnt = files.filter((f) => f.projectId === p.id).length
        return `• ${p.code} — ${p.name} (${cnt} ไฟล์)`
      })
      .join('\n')
    return {
      intent: 'answer',
      reply: `มี ${projects.length} โครงการ:\n${list}`,
    }
  }

  // Stats
  if (intent === 'stats') {
    const typeCount = {}
    files.forEach((f) => {
      typeCount[f.type] = (typeCount[f.type] || 0) + 1
    })
    const typeBreak = Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  • ${TYPE_LABEL[k] || k}: ${n}`)
      .join('\n')
    const latest = files.filter((f) => f.isLatest).length
    return {
      intent: 'answer',
      reply: `📊 สถิติระบบ:\n• โครงการ: ${projects.length}\n• ไฟล์ทั้งหมด: ${files.length}\n• Version ล่าสุด: ${latest}\n\nประเภทเอกสาร:\n${typeBreak}`,
    }
  }

  // Parse criteria
  const mProject = matchProject(text, projects)
  const mType = matchType(text)
  const timeRange = parseTimeRange(text)
  const sizeFilter = parseSizeFilter(text)
  const uploaders = Array.from(new Set(files.map((f) => f.uploader).filter(Boolean)))
  const mUploader = parseUploader(text, uploaders)
  const contentQuery = parseContentQuery(text)

  // Filename keyword (e.g., "boq.pdf", "EIA_MRT")
  const filenameKw = (text.match(/[฀-๿a-zA-Z0-9_-]{3,}\.[a-z]{2,5}/i) || [null])[0]

  // ZIP intent
  if (intent === 'zip') {
    if (mProject) {
      return {
        intent: 'download_zip',
        reply: `จะรวม Zip ของโครงการ **${mProject.project.code}** (${mProject.project.name}) ให้ครับ`,
        projectCode: mProject.project.code,
      }
    }
    return { intent: 'answer', reply: 'กรุณาระบุชื่อหรือรหัสโครงการที่ต้องการ Zip ครับ' }
  }

  // Build candidate set
  let candidates = files
  const scope = []
  if (mProject) {
    candidates = candidates.filter((f) => f.projectId === mProject.project.id)
    scope.push(`โครงการ ${mProject.project.code}`)
  }
  if (mType) {
    candidates = candidates.filter((f) => f.type === mType.type)
    scope.push(`ประเภท ${mType.label}`)
  }
  if (timeRange) {
    candidates = candidates.filter((f) => {
      const ts = new Date(f.date).getTime()
      if (timeRange.from && ts < timeRange.from) return false
      if (timeRange.to && ts > timeRange.to) return false
      return true
    })
    scope.push(timeRange.label)
  }
  if (sizeFilter) {
    if (sizeFilter.min) candidates = candidates.filter((f) => (f.size || 0) >= sizeFilter.min)
    if (sizeFilter.max) candidates = candidates.filter((f) => (f.size || 0) <= sizeFilter.max)
    scope.push(sizeFilter.label)
  }
  if (mUploader) {
    candidates = candidates.filter((f) => f.uploader === mUploader.name)
    scope.push(mUploader.label)
  }
  if (filenameKw) {
    candidates = candidates.filter((f) => f.name.toLowerCase().includes(filenameKw.toLowerCase()))
    scope.push(`ชื่อมี "${filenameKw}"`)
  }

  // Content search — looks inside extracted text
  // Supports exact phrase + individual word fallback
  let contentMatches = null
  if (contentQuery) {
    const kw = contentQuery.keyword.toLowerCase()
    // Significant words (len >= 2) for fallback matching
    const words = kw.split(/[\s,]+/).filter((w) => w.length >= 2)

    const matched = []
    const notIndexed = []
    for (const f of candidates) {
      if (!f.contentText) {
        notIndexed.push(f)
        continue
      }
      const ct = f.contentText.toLowerCase()

      let matchedKw = null
      let matchedIdx = -1

      // Pass 1: Exact phrase
      if (ct.includes(kw)) {
        matchedKw = kw
        matchedIdx = ct.indexOf(kw)
      } else if (words.length > 1) {
        // Pass 2: ALL significant words must appear (AND match, anywhere in doc)
        const allFound = words.every((w) => ct.includes(w))
        if (allFound) {
          // Pick first occurrence for snippet
          matchedKw = words[0]
          matchedIdx = ct.indexOf(words[0])
        }
      }

      if (matchedKw !== null && matchedIdx >= 0) {
        const len = matchedKw.length
        const start = Math.max(0, matchedIdx - 60)
        const end = Math.min(f.contentText.length, matchedIdx + len + 60)
        let snippet = f.contentText.slice(start, end)
        if (start > 0) snippet = '...' + snippet
        if (end < f.contentText.length) snippet = snippet + '...'
        matched.push({ file: f, snippet: snippet.replace(/\s+/g, ' ').trim() })
      }
    }
    candidates = matched.map((m) => ({ ...m.file, _snippet: m.snippet }))
    scope.push(contentQuery.label)
    contentMatches = { matched, notIndexed }
  }

  // Free-text keyword search (additional)
  const cleanQuery = text
    .toLowerCase()
    .replace(/(หา|ขอ|เอา|ส่ง|ดู|find|search|get|show|ล่าสุด|latest|ทั้งหมด|all|เมื่อ.*?วัน|เดือน.*?นี้|สัปดาห์.*?นี้|วันนี้|today)/gi, '')
    .replace(/[\s,;:!?]+/g, ' ')
    .trim()
  if (cleanQuery && cleanQuery.length >= 3 && candidates.length > 5) {
    const tokens = cleanQuery.split(' ').filter((t) => t.length >= 2)
    if (tokens.length > 0) {
      const scored = candidates.map((f) => {
        let score = 0
        const name = f.name.toLowerCase()
        const baseName = (f.baseName || '').toLowerCase()
        for (const tok of tokens) {
          if (name.includes(tok)) score += 2
          if (baseName.includes(tok)) score += 1
        }
        return { file: f, score }
      })
      const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
      if (matched.length > 0) candidates = matched.map((s) => s.file)
    }
  }

  // Count intent — special case: count of projects (not files)
  if (intent === 'count' && /โครงการ/.test(text) && !/(ไฟล์|เอกสาร|file|doc|รูป|version)/.test(text)) {
    return {
      intent: 'answer',
      reply: `ระบบมี **${projects.length}** โครงการ${projects.length > 0 ? ' ลองพิมพ์ "มีโครงการอะไรบ้าง" เพื่อดูรายการครับ' : ''}`,
    }
  }

  // Count intent — context-aware
  if (intent === 'count') {
    const latest = candidates.filter((f) => f.isLatest).length
    const scopeLabel = scope.length ? scope.join(' · ') : null

    // No results
    if (candidates.length === 0) {
      return {
        intent: 'answer',
        reply: scopeLabel
          ? `ไม่พบไฟล์ใน "${scopeLabel}" ครับ`
          : 'ระบบยังไม่มีไฟล์เลยครับ',
      }
    }

    // Build reply text
    let reply
    if (scopeLabel) {
      reply = `**${scopeLabel}** มี **${candidates.length}** ไฟล์`
    } else {
      reply = `ระบบมีไฟล์ทั้งหมด **${candidates.length}** ไฟล์`
    }
    if (latest > 0 && latest !== candidates.length) {
      reply += ` (Version ล่าสุด ${latest} ไฟล์)`
    }

    // If small set (≤ 5), also show the files
    if (candidates.length > 0 && candidates.length <= 5) {
      return {
        intent: 'list',
        reply: reply + ':',
        files: [...candidates].sort((a, b) => new Date(b.date) - new Date(a.date)),
      }
    }

    return { intent: 'answer', reply }
  }

  // Who uploaded
  if (intent === 'who') {
    const counts = {}
    candidates.forEach((f) => {
      if (f.uploader) counts[f.uploader] = (counts[f.uploader] || 0) + 1
    })
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    if (top.length === 0) {
      return { intent: 'answer', reply: 'ไม่มีข้อมูลผู้อัพโหลดครับ' }
    }
    const list = top.map(([u, n]) => `  • ${u}: ${n} ไฟล์`).join('\n')
    return {
      intent: 'answer',
      reply: `👥 ผู้อัพโหลด${scope.length ? ` (${scope.join(' · ')})` : ''}:\n${list}`,
    }
  }

  // When intent
  if (intent === 'when' && candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => new Date(b.date) - new Date(a.date))
    const f = sorted[0]
    return {
      intent: 'list',
      reply: `ไฟล์ล่าสุดที่อัพ${scope.length ? ` (${scope.join(' · ')})` : ''}: **${f.name}** เมื่อ ${new Date(f.date).toLocaleDateString('th-TH')}`,
      files: sorted.slice(0, 3),
    }
  }

  // FIND intent (default)
  // Determine latest only or all
  const wantLatest = /(ล่าสุด|latest|ใหม่ที่สุด|newest)/i.test(text)
  const wantAll = /(ทั้งหมด|all|every|ทุก|ทุกตัว)/i.test(text)

  let resultFiles = candidates
  if (wantLatest && !wantAll) {
    resultFiles = resultFiles.filter((f) => f.isLatest)
  }

  // Sort
  if (sizeFilter?.sort === 'desc') {
    resultFiles = [...resultFiles].sort((a, b) => (b.size || 0) - (a.size || 0))
  } else if (sizeFilter?.sort === 'asc') {
    resultFiles = [...resultFiles].sort((a, b) => (a.size || 0) - (b.size || 0))
  } else {
    // Default: newest first
    resultFiles = [...resultFiles].sort((a, b) => new Date(b.date) - new Date(a.date))
  }

  if (resultFiles.length === 0) {
    if (candidates.length === 0) {
      // Special note for content search: if nothing matched and there are non-indexed files
      let extraNote = ''
      if (contentMatches && contentMatches.notIndexed.length > 0) {
        extraNote = `\n\n💡 หมายเหตุ: มี ${contentMatches.notIndexed.length} ไฟล์ที่ยังไม่ได้สกัดข้อความ — ลองเปิดโครงการ → คลิก "Re-index" เพื่อให้ระบบค้นในเนื้อหา`
      }
      return {
        intent: 'answer',
        reply: `ไม่พบไฟล์${scope.length ? ` (${scope.join(' · ')})` : ''}ครับ${extraNote}\nลองเปลี่ยนเงื่อนไขหรือพิมพ์ "มีโครงการอะไรบ้าง" เพื่อดูรายการ`,
      }
    }
    // Has candidates but filter removed all (e.g., wantLatest but no latest)
    resultFiles = candidates.sort((a, b) => new Date(b.date) - new Date(a.date))
  }

  // up to 50 names; the chat shows <= 8 as pickable files, more as a list + "open the project" (AIChat PICK_MAX)
  const limit = 50
  const shown = resultFiles.slice(0, limit)
  const scopeText = scope.length ? ` — ${scope.join(' · ')}` : ''

  let reply
  if (resultFiles.length === 1) {
    const f = resultFiles[0]
    reply = `เจอ 1 ไฟล์${scopeText}:\n📄 ${f.name}`
  } else {
    reply = `เจอ **${resultFiles.length} ไฟล์**${scopeText}`
  }

  return {
    intent: 'list',
    reply,
    files: shown,
    matchCount: resultFiles.length,
  }
}
