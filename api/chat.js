// Vercel Serverless Function for Real Claude AI Integration
// Activates when ANTHROPIC_API_KEY env var is set in Vercel
//
// Endpoint: POST /api/chat
// Body: { query, context }
// Returns: { intent, reply, files, projectCode }

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(200).json({
      intent: 'answer',
      reply: '__USE_LOCAL__', // signal to client: use local rule-based
      fallback: true,
    })
  }

  try {
    const { query, context, history } = req.body || {}
    if (!query) {
      return res.status(400).json({ error: 'Missing query' })
    }

    // Build context summary
    const { projects = [], files = [] } = context || {}
    const projLines = projects
      .map((p) => `- ${p.code}: ${p.name} (${files.filter((f) => f.projectId === p.id).length} ไฟล์)`)
      .join('\n')

    const latestFiles = files
      .filter((f) => f.isLatest)
      .slice(0, 50) // limit context
      .map((f) => {
        const p = projects.find((x) => x.id === f.projectId)
        return `  · [${f.type}] ${f.name} — โครงการ ${p?.code || '?'} (${f.date}, ${f.size}KB)`
      })
      .join('\n')

    const systemPrompt = `คุณคือ AI Document Agent สำหรับระบบจัดการเอกสารก่อสร้าง TCM
ตอบเป็นภาษาไทย กระชับ มืออาชีพ เหมาะกับวิศวกร/ผู้จัดการโครงการ

ข้อมูลปัจจุบันในระบบ:

โครงการ (${projects.length} โครงการ):
${projLines || '- ยังไม่มีโครงการ'}

ไฟล์ Version ล่าสุด (${files.filter((f) => f.isLatest).length} ไฟล์):
${latestFiles || '- ยังไม่มีไฟล์'}

ตอบเป็น JSON อย่างเดียว (ห้ามมี markdown code block) รูปแบบ:
{
  "intent": "list" | "download_zip" | "answer",
  "reply": "ข้อความตอบกลับสั้นๆ ภาษาไทย (1-3 ประโยค)",
  "fileIds": ["id1", "id2", ...] (array of file IDs to show, max 8 items, only if intent=list, อ้างอิงจาก fileId ของไฟล์ที่ตรงกับคำถาม),
  "projectCode": "รหัสโครงการ เช่น MRT-PP" (only if intent=download_zip)
}

หมายเหตุ:
- ถ้า intent=list ให้ใส่ fileIds เป็น array ของ id ที่ตรงกับคำถาม
- ถ้าผู้ใช้ขอ "ทั้งหมด" รวม version เก่าด้วย; ถ้าขอ "ล่าสุด" หรือไม่ระบุ → เลือกเฉพาะ isLatest
- ถ้า fileIds มีหลายรายการ ให้เรียงตามวันที่ใหม่สุดก่อน
- ถ้าไม่พบไฟล์ ให้ใช้ intent=answer และตอบว่า "ไม่พบไฟล์ที่ตรงเงื่อนไข ลองเปลี่ยนคำค้น"

============================================================
โหมดพิเศษ: ตรวจสอบความครบถ้วนของเอกสารขออนุญาตก่อสร้าง
============================================================
ถ้าผู้ใช้ถามเกี่ยวกับ "เอกสารขออนุญาตก่อสร้าง", "เอกสารแนบขออนุญาต", "ตรวจสอบเอกสารครบไหม", หรือคล้ายกัน
ให้สวมบทบาทเป็นสถาปนิกอาวุโสที่ให้คำปรึกษาด้านกฎหมายควบคุมอาคาร (พ.ร.บ. ควบคุมอาคาร พ.ศ. 2522) และสนทนาแบบถามตอบทีละขั้น (ใช้ intent=answer เสมอในโหมดนี้ ไม่ต้องมี fileIds):

ลำดับการสนทนา:
1. ถ้ายังไม่รู้ประเภท/ขนาดอาคารและที่ตั้งโครงการ (กทม. หรือต่างจังหวัด) ให้ถามก่อน เพราะมีผลต่อเอกสารที่ต้องใช้ (เช่น อาคาร >150 ตร.ม. หรือ >2 ชั้น ต้องมีสถาปนิกเซ็นแบบ, โครงการเข้าเกณฑ์ EIA หรือไม่)
2. เมื่อรู้ประเภทอาคารแล้ว ให้ถามทีละหมวด (ไม่ถามพรวนทีเดียวหมด) ว่ามีเอกสารต่อไปนี้แล้วหรือยัง:
   หมวดเอกสารตัวบุคคล/นิติกรรม: บัตรประชาชน+ทะเบียนบ้านเจ้าของอาคาร, หนังสือรับรองนิติบุคคล (ถ้าเป็นบริษัท), หนังสือมอบอำนาจ, โฉนดที่ดิน/น.ส.3ก, หนังสือยินยอมเจ้าของที่ดิน (ถ้าเช่า), หนังสือยินยอมก่อสร้างชิดเขต (ถ้าชิดแนวเขต)
   หมวดแบบแปลน/วิศวกรรม: แบบแปลนที่สถาปนิกลงนาม, รายการคำนวณโครงสร้างที่วิศวกรโยธาลงนาม, แบบวิศวกรรมโครงสร้าง, แบบระบบไฟฟ้า, แบบระบบสุขาภิบาล/ประปา, แบบระบบป้องกันอัคคีภัย (อาคารสูง/ใหญ่พิเศษ), สำเนาใบอนุญาตประกอบวิชาชีพของผู้ลงนามทุกคน
   หมวดเอกสารเฉพาะกรณี: รายงาน EIA (ถ้าเข้าเกณฑ์), ผลตรวจสอบสภาพดิน (อาคารใหญ่/สูง), หนังสือรับรองผลกระทบอาคารข้างเคียง, แบบระบบบำบัดน้ำเสีย (อาคารขนาดใหญ่)
   หมวดแบบฟอร์มราชการ: แบบ ข.1 (คำขออนุญาตก่อสร้าง), แบบ น.1 (กรณีดัดแปลงอาคาร)
3. จดจำคำตอบจากทุกข้อความก่อนหน้าในบทสนทนานี้ (ห้ามถามซ้ำสิ่งที่ผู้ใช้ตอบไปแล้ว)
4. เมื่อถามครบทุกหมวดแล้ว ให้สรุปเป็นรายการว่าเอกสารไหนครบ/ขาดอะไรบ้าง พร้อมระบุกฎหมายอ้างอิงสั้นๆ (เช่น พ.ร.บ. ควบคุมอาคาร พ.ศ. 2522, กฎกระทรวงฉบับที่ 33)
5. ย้ำเสมอว่านี่คือคำแนะนำเบื้องต้น ไม่ใช่คำปรึกษาทางกฎหมายอย่างเป็นทางการ ควรตรวจสอบกับผู้ประกอบวิชาชีพหรือสำนักงานเขต/อปท. อีกครั้งก่อนยื่นจริง`

    // Add file ID to context for AI reference
    const filesWithIds = files
      .slice(0, 100) // limit
      .map((f) => `id=${f.id} | ${f.name} | type=${f.type} | size=${f.size}KB | date=${f.date} | uploader=${f.uploader || '?'} | isLatest=${f.isLatest}`)
      .join('\n')

    const userPrompt = `รายการไฟล์ทั้งหมด (id | filename | type | size | date | uploader | isLatest):
${filesWithIds}

คำถามผู้ใช้: "${query}"

ตอบเป็น JSON ตามรูปแบบที่กำหนด เลือก fileIds ที่ตรงคำถามให้ตรงที่สุด`

    // Prior turns (plain text only) so multi-step conversations — like the permit
    // document checklist — don't get re-asked the same question every message.
    const historyMessages = (Array.isArray(history) ? history : [])
      .slice(-12)
      .map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.text || '' }))
      .filter((m) => m.content)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [...historyMessages, { role: 'user', content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Anthropic API error:', response.status, errorText)
      return res.status(200).json({
        intent: 'answer',
        reply: '__USE_LOCAL__',
        fallback: true,
        error: `API error: ${response.status}`,
      })
    }

    const data = await response.json()
    const rawText = data.content?.[0]?.text || ''

    // Strip code blocks if any
    const cleaned = rawText.replace(/```json|```/g, '').trim()

    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      console.error('Parse error:', e, 'Raw:', rawText)
      return res.status(200).json({
        intent: 'answer',
        reply: rawText || 'ขออภัย ระบบไม่สามารถวิเคราะห์คำตอบได้',
      })
    }

    // Map fileIds back to full file objects
    if (parsed.intent === 'list' && Array.isArray(parsed.fileIds)) {
      const fileMap = {}
      files.forEach((f) => (fileMap[f.id] = f))
      parsed.files = parsed.fileIds.map((id) => fileMap[id]).filter(Boolean).slice(0, 8)
      delete parsed.fileIds
    }

    return res.status(200).json(parsed)
  } catch (err) {
    console.error('Chat handler error:', err)
    return res.status(200).json({
      intent: 'answer',
      reply: '__USE_LOCAL__',
      fallback: true,
      error: err.message,
    })
  }
}
