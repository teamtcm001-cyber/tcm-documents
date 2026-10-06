import { useState } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { addProgressUpdate } from '../api/supabase.js'
import { getLocalName } from '../utils/localIdentity.js'
import {
  todayTH, fmtThaiDate, fmtThaiDateTime, daysBetween, elapsedPctAt, dailyProgressSeries, isStale, isIsoDate, isSaneDate, isMine,
  BEHIND_POINTS, INSANE_DATE_MESSAGE,
} from '../utils/tracking.js'
import { ProgressMeter, MeterLegend, ToneBadge } from './TrackingBits.jsx'

// ---------- trend chart (inline SVG) ----------
const W = 640
const H = 220
const PAD = { l: 38, r: 16, t: 14, b: 30 }

function ProgressTrend({ history, start, end }) {
  const series = dailyProgressSeries(history) // one point per day, last entry wins
  if (series.length === 0) {
    return <div className="trk-empty">ยังไม่มีข้อมูลให้แสดงกราฟ</div>
  }

  const today = todayTH()
  const dates = [...series.map((s) => s.as_of), today]
  if (start && end) dates.push(start, end)
  let minD = dates.reduce((a, b) => (a < b ? a : b))
  let maxD = dates.reduce((a, b) => (a > b ? a : b))
  if (minD === maxD) maxD = new Date(Date.parse(minD) + 86400000).toISOString().slice(0, 10)
  const span = daysBetween(minD, maxD)
  const x = (d) => PAD.l + ((W - PAD.l - PAD.r) * daysBetween(minD, d)) / span
  const y = (p) => PAD.t + (H - PAD.t - PAD.b) * (1 - p / 100)

  // reference line = time elapsed % (0 before start, 100 after end)
  let ref = null
  if (start && end && end > start) {
    const pts = []
    if (minD < start) pts.push([minD, 0])
    pts.push([start, 0], [end, 100])
    if (maxD > end) pts.push([maxD, 100])
    ref = pts.map(([d, p]) => `${x(d)},${y(p)}`).join(' ')
  }

  const line = series.map((s) => `${x(s.as_of)},${y(s.percent_complete)}`).join(' ')
  const last = series[series.length - 1]
  const ticks = [0, 1, 2, 3].map((i) => {
    const d = new Date(Date.parse(minD) + (i * span * 86400000) / 3).toISOString().slice(0, 10)
    return d
  })
  const elapsedNow = elapsedPctAt(start, end, today)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="trk-chart"
      role="img"
      aria-label={`กราฟความคืบหน้า ล่าสุด ${last.percent_complete}%${elapsedNow == null ? '' : ` เทียบกับเวลาที่ผ่านไป ${elapsedNow}%`}`}
    >
      {[0, 25, 50, 75, 100].map((p) => (
        <g key={p}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke="#E5E9EF" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(p) + 4} textAnchor="end" fontSize="11" fill="#6B7280">
            {p}%
          </text>
        </g>
      ))}
      {ticks.map((d, i) => (
        <text
          key={i}
          x={Math.min(Math.max(x(d), PAD.l + 14), W - PAD.r - 14)}
          y={H - 8}
          textAnchor="middle"
          fontSize="11"
          fill="#6B7280"
        >
          {fmtThaiDate(d)}
        </text>
      ))}
      {today >= minD && today <= maxD && (
        <line x1={x(today)} x2={x(today)} y1={PAD.t} y2={H - PAD.b} stroke="#9AA3AF" strokeDasharray="3 4" strokeWidth="1" />
      )}
      {ref && <polyline points={ref} fill="none" stroke="#B45309" strokeWidth="2" strokeDasharray="6 4" />}
      <polyline points={line} fill="none" stroke="#3A6EA5" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {series.map((s) => (
        <circle key={s.as_of} cx={x(s.as_of)} cy={y(s.percent_complete)} r="3.5" fill="#3A6EA5" stroke="#fff" strokeWidth="1.5">
          <title>{`${fmtThaiDate(s.as_of)}: ${s.percent_complete}%`}</title>
        </circle>
      ))}
      <text
        x={Math.min(x(last.as_of), W - PAD.r - 18)}
        y={y(last.percent_complete) - 9}
        textAnchor="middle"
        fontSize="12"
        fontWeight="600"
        fill="#1F3A5F"
      >
        {last.percent_complete}%
      </text>
    </svg>
  )
}

// ---------- panel ----------
export default function TrackingProgress({ row, history, onSaved }) {
  const toast = useToast()
  const today = todayTH()
  const [percent, setPercent] = useState(String(row.percent_complete ?? 0))
  const [asOf, setAsOf] = useState(today)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  const localName = getLocalName()
  const otherCo = row.project_co && !isMine(row.project_co, localName)
  const never = row.percent_complete == null
  const gap = !never && row.time_elapsed_pct != null ? row.time_elapsed_pct - row.percent_complete : null
  const sameDay = history.find((h) => h.as_of === asOf)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const raw = String(percent).trim()
    const n = Number(raw)
    if (raw === '' || !Number.isInteger(n) || n < 0 || n > 100) {
      setError('% ต้องเป็นจำนวนเต็ม 0–100 (ไม่มีทศนิยม)')
      return
    }
    if (!isIsoDate(asOf)) {
      setError('กรุณาเลือกวันที่ข้อมูล')
      return
    }
    if (!isSaneDate(asOf)) {
      setError(INSANE_DATE_MESSAGE)
      return
    }
    if (asOf > today) {
      setError('วันที่ข้อมูลต้องไม่เกินวันนี้')
      return
    }
    if (!never && n < row.percent_complete && asOf >= row.progress_as_of) {
      if (!window.confirm(`% ลดลงจากเดิม (${row.percent_complete}% → ${n}%) ยืนยันบันทึก?`)) return
    }
    if (!never && asOf < row.progress_as_of) {
      if (
        !window.confirm(
          `วันที่ ${fmtThaiDate(asOf)} เก่ากว่าข้อมูลล่าสุด (${fmtThaiDate(row.progress_as_of)}) — รายการนี้จะเก็บเป็นประวัติ และจะไม่เปลี่ยนค่าปัจจุบัน ยืนยันบันทึก?`
        )
      )
        return
    }
    setSaving(true)
    try {
      await addProgressUpdate(row.project_id, { percent: n, asOf, note })
      toast(`บันทึก ${n}% เรียบร้อย`)
      setNote('')
      await onSaved?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const shown = showAll ? history : history.slice(0, 6)

  return (
    <div className="card trk-panel">
      <h3 className="trk-panel-h">
        <Icon name="trend-up" size={16} /> % ความคืบหน้า (Complete)
      </h3>

      <div className="trk-prog-top">
        <div className="trk-big">
          {never ? <span className="trk-big-empty">ยังไม่เคยอัปเดต</span> : <>{row.percent_complete}<small>%</small></>}
        </div>
        <div className="trk-prog-side">
          <ProgressMeter percent={row.percent_complete} elapsed={row.time_elapsed_pct} tall />
          <MeterLegend percent={row.percent_complete} elapsed={row.time_elapsed_pct} />
          {gap != null && (
            <div className={`trk-gap ${gap > BEHIND_POINTS ? 'bad' : gap > 0 ? 'warn' : 'ok'}`}>
              {gap > 0 ? `ตามหลังเวลา ${gap} จุด` : gap < 0 ? `เร็วกว่าเวลา ${-gap} จุด` : 'ตรงตามเวลา'}
            </div>
          )}
          {row.time_elapsed_pct == null && (
            <div className="trk-hint">ใส่วันเริ่ม/สิ้นสุดสัญญาที่หัวหน้านี้ เพื่อเทียบกับเวลา</div>
          )}
          <div className="trk-asof">
            {never ? (
              <ToneBadge tone="warn">ยังไม่เคยอัปเดต</ToneBadge>
            ) : (
              <>
                <span>
                  ณ {fmtThaiDate(row.progress_as_of)} · โดย {row.progress_updated_by}
                </span>
                {isStale(row) && <ToneBadge tone="warn">ไม่อัปเดต {row.days_since_update} วัน</ToneBadge>}
              </>
            )}
          </div>
          {row.progress_note && <div className="trk-note">“{row.progress_note}”</div>}
        </div>
      </div>

      <form className="trk-form" onSubmit={submit} noValidate>
        <div className="trk-form-title">อัปเดต %</div>
        <div className="trk-form-row">
          <div className="field" style={{ flex: '2 1 220px' }}>
            <label htmlFor="trk-pct">% ความคืบหน้า (จำนวนเต็ม)</label>
            <div className="trk-pct-input">
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={percent === '' ? 0 : percent}
                onChange={(e) => setPercent(e.target.value)}
                aria-label="เลื่อนเพื่อเลือก % ความคืบหน้า"
              />
              <input
                id="trk-pct"
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div className="field" style={{ flex: '1 1 170px' }}>
            <label htmlFor="trk-asof">ข้อมูล ณ วันที่</label>
            <input id="trk-asof" type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} />
            <span className="muted small">{isIsoDate(asOf) ? `= ${fmtThaiDate(asOf, { long: true })}` : ''}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="trk-note">หมายเหตุ (ไม่บังคับ)</label>
          <input
            id="trk-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เช่น งานฐานรากเสร็จ 80% ตามรายงานประจำสัปดาห์"
          />
        </div>
        {sameDay && (
          <div className="trk-hint">
            วันที่นี้มีการบันทึกแล้ว ({sameDay.percent_complete}% โดย {sameDay.updated_by}) — รายการใหม่จะแสดงแทนในกราฟ
            ส่วนรายการเดิมยังเก็บในประวัติ
          </div>
        )}
        {otherCo && (
          <div className="trk-hint">
            โปรเจกต์นี้ระบุ Project Co เป็น "{row.project_co}" — การบันทึกจะลงชื่อ "{localName}" ระบบไม่ได้จำกัดสิทธิ์ตามชื่อ
          </div>
        )}
        {error && (
          <div className="auth-msg err" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          <Icon name="check" size={14} /> {saving ? 'กำลังบันทึก...' : 'บันทึก %'}
        </button>
      </form>

      <div className="trk-sub-h">แนวโน้ม (เส้นประ = เวลาที่ผ่านไปตามสัญญา)</div>
      <ProgressTrend history={history} start={row.start_date} end={row.end_date} />

      <div className="trk-sub-h">ประวัติการอัปเดต ({history.length})</div>
      {history.length === 0 ? (
        <div className="trk-empty">ยังไม่มีประวัติ</div>
      ) : (
        <>
          <div className="trk-table-wrap">
            <table className="trk-table">
              <thead>
                <tr>
                  <th>ข้อมูล ณ</th>
                  <th>%</th>
                  <th>เปลี่ยน</th>
                  <th>โดย</th>
                  <th>หมายเหตุ</th>
                  <th>บันทึกเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((h, i) => {
                  const prev = history[i + 1]
                  const d = prev ? h.percent_complete - prev.percent_complete : null
                  return (
                    <tr key={h.id}>
                      <td>{fmtThaiDate(h.as_of)}</td>
                      <td><b>{h.percent_complete}%</b></td>
                      <td className={d > 0 ? 'up' : d < 0 ? 'down' : ''}>
                        {d == null ? '-' : d > 0 ? `+${d}` : d}
                      </td>
                      <td>{h.updated_by}</td>
                      <td>{h.note || '-'}</td>
                      <td className="muted">{fmtThaiDateTime(h.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {history.length > 6 && (
            <button type="button" className="trk-link-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'แสดงน้อยลง' : `ดูทั้งหมด (${history.length})`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
