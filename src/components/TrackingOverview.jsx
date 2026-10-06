import { useEffect, useMemo, useState } from 'react'
import Icon from './Icon.jsx'
import { fetchTrackingOverview } from '../api/supabase.js'
import { getLocalName } from '../utils/localIdentity.js'
import {
  computeHealth, HEALTH_ORDER, isMine, isStale, nextInstallmentLine, docsStateText, fmtThaiDate, todayTH,
} from '../utils/tracking.js'
import {
  HealthChip, ToneBadge, ProgressMeter, MeterLegend, NotInstalledNotice, ErrorNotice, PartialDataNotice, CriteriaPopover,
} from './TrackingBits.jsx'

function ProjectRow({ item, mineName, onOpen }) {
  const { row, health } = item
  const next = nextInstallmentLine(row)
  const docs = row.next_installment_id
    ? docsStateText(row.next_docs_state, row.next_required_docs_total, row.next_required_docs_attached)
    : null
  const mine = isMine(row.project_co, mineName)
  const never = row.days_since_update == null
  const stale = isStale(row)

  const open = () => onOpen(row.project_id)
  return (
    <article
      className={`trk-card trk-h-${health.level}`}
      role="button"
      tabIndex={0}
      aria-label={`${row.project_name} สถานะ ${health.level === 'red' ? 'ต้องดำเนินการ' : health.level === 'amber' ? 'ควรติดตาม' : 'ปกติ'} เปิดรายละเอียด`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <div className="trk-card-top">
        <HealthChip level={health.level} />
        <div className="trk-id">
          <div className="trk-name">{row.project_name}</div>
          <div className="trk-sub">
            <span>{row.project_code}</span>
            <span>
              <Icon name="user" size={12} /> Project Co: {row.project_co || 'ยังไม่ระบุ'}
            </span>
            {mine && <ToneBadge tone="info">โปรเจกต์ของฉัน</ToneBadge>}
          </div>
        </div>
        <Icon name="arrow-r" size={16} style={{ color: 'var(--gray-400)', flexShrink: 0 }} />
      </div>

      <div className="trk-card-grid">
        <div className="trk-col">
          <div className="trk-col-h">ความคืบหน้า เทียบกับเวลา</div>
          <ProgressMeter percent={row.percent_complete} elapsed={row.time_elapsed_pct} />
          <MeterLegend percent={row.percent_complete} elapsed={row.time_elapsed_pct} />
          {row.time_elapsed_pct == null && (
            <div className="trk-hint">ยังไม่ระบุวันเริ่ม/สิ้นสุดสัญญา จึงเทียบกับเวลาไม่ได้</div>
          )}
          <div className="trk-asof">
            {never ? (
              <ToneBadge tone="warn">ยังไม่เคยอัปเดต</ToneBadge>
            ) : (
              <>
                <span>
                  ณ {fmtThaiDate(row.progress_as_of)} · โดย {row.progress_updated_by}
                </span>
                {stale && <ToneBadge tone="warn">ไม่อัปเดต {row.days_since_update} วัน</ToneBadge>}
              </>
            )}
          </div>
        </div>

        <div className="trk-col">
          <div className="trk-col-h">งวดเบิกถัดไป</div>
          <div className={`trk-next trk-text-${next.tone}`}>{next.text}</div>
          {docs && (
            <div style={{ marginTop: 6 }}>
              <ToneBadge tone={docs.tone}>
                <Icon name={docs.tone === 'ok' ? 'check' : docs.tone === 'bad' ? 'alert' : 'info'} size={11} /> {docs.text}
              </ToneBadge>
            </div>
          )}
          <div className="trk-counts">
            <span>
              เบิกแล้ว <b>{row.installments_billed}/{row.installments_total}</b> งวด
            </span>
            {row.installments_overdue > 0 && (
              <ToneBadge tone="bad">เลยกำหนด {row.installments_overdue} งวด</ToneBadge>
            )}
            {row.installments_returned > 0 && (
              <ToneBadge tone="bad">ตีกลับ {row.installments_returned} งวด</ToneBadge>
            )}
          </div>
        </div>
      </div>

      {health.reasons.length > 0 && (
        <div className="trk-reasons">
          <Icon name="info" size={13} /> {health.reasons.join(' · ')}
        </div>
      )}
    </article>
  )
}

export default function TrackingOverview({ onOpenProject }) {
  const [state, setState] = useState({ loading: true, rows: [], notInstalled: false, error: null, partial: false })
  const [onlyMine, setOnlyMine] = useState(false)
  const [onlyAction, setOnlyAction] = useState(false)
  const localName = getLocalName()

  const load = async () => {
    setState((s) => ({ ...s, loading: true }))
    const res = await fetchTrackingOverview()
    setState({
      loading: false,
      rows: res.data || [],
      notInstalled: res.notInstalled,
      error: res.notInstalled ? null : res.error,
      partial: !!res.partial,
    })
  }

  useEffect(() => {
    load()
  }, [])

  const items = useMemo(
    () => state.rows.map((row) => ({ row, health: computeHealth(row) })),
    [state.rows]
  )

  const summary = useMemo(() => {
    const s = { red: 0, amber: 0, green: 0, overdue: 0 }
    items.forEach(({ row, health }) => {
      s[health.level] += 1
      s.overdue += row.installments_overdue || 0
    })
    return s
  }, [items])

  const myCount = items.filter(({ row }) => isMine(row.project_co, localName)).length

  const visible = items
    .filter(({ row }) => !onlyMine || isMine(row.project_co, localName))
    .filter(({ health }) => !onlyAction || health.level !== 'green')
    .sort(
      (a, b) =>
        HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] ||
        (a.row.project_name || '').localeCompare(b.row.project_name || '', 'th')
    )

  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div className="section-title">
            <h2>ติดตามงานโครงการ</h2>
            <div className="sub">
              % ความคืบหน้า · งวดเบิก · ความพร้อมของเอกสาร · ข้อมูล ณ {fmtThaiDate(todayTH())}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={state.loading}>
            <Icon name="refresh" size={14} /> รีเฟรช
          </button>
        </div>

        {state.loading && state.rows.length === 0 ? (
          <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
            <div className="spinner" />
          </div>
        ) : state.notInstalled ? (
          <NotInstalledNotice onRetry={load} />
        ) : state.error ? (
          <ErrorNotice message={state.error.message} onRetry={load} />
        ) : (
          <>
            {state.partial && <PartialDataNotice onRetry={load} />}
            <div className="trk-banner" aria-live="polite">
              <div className="trk-banner-cell red">
                <div className="n">{summary.red}</div>
                <div className="l">ต้องดำเนินการ</div>
              </div>
              <div className="trk-banner-cell amber">
                <div className="n">{summary.amber}</div>
                <div className="l">ควรติดตาม</div>
              </div>
              <div className="trk-banner-cell green">
                <div className="n">{summary.green}</div>
                <div className="l">ปกติ</div>
              </div>
              <div className="trk-banner-cell overdue">
                <div className="n">{summary.overdue}</div>
                <div className="l">งวดเลยกำหนดเบิก (รวม)</div>
              </div>
            </div>

            <div className="trk-toolbar">
              <button
                className={`filter-chip ${onlyMine ? 'on' : ''}`}
                aria-pressed={onlyMine}
                onClick={() => setOnlyMine((v) => !v)}
                title="จับคู่ชื่อที่คุณกรอกตอนเข้าระบบ กับช่อง Project Co ของโครงการ (เป็นเพียงตัวกรอง ไม่ใช่การจำกัดสิทธิ์)"
              >
                <Icon name="user" size={12} /> โปรเจกต์ของฉัน ({myCount})
              </button>
              <button
                className={`filter-chip ${onlyAction ? 'on' : ''}`}
                aria-pressed={onlyAction}
                onClick={() => setOnlyAction((v) => !v)}
              >
                <Icon name="alert" size={12} /> เฉพาะที่ต้องดำเนินการ ({summary.red + summary.amber})
              </button>
              <CriteriaPopover />
              <span className="muted small trk-toolbar-note">
                ใครก็แก้ได้ทุกโครงการ — "โปรเจกต์ของฉัน" เป็นเพียงตัวกรองตามชื่อ ไม่ใช่การจำกัดสิทธิ์
              </span>
            </div>

            {items.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--gray-500)' }}>
                <Icon name="folder" size={32} />
                <div style={{ marginTop: 8 }}>ยังไม่มีโครงการในระบบ</div>
              </div>
            ) : visible.length === 0 ? (
              <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--gray-500)' }}>
                {onlyMine && myCount === 0 ? (
                  <>
                    ยังไม่มีโครงการที่ระบุ Project Co เป็นชื่อของคุณ ("{localName}")
                    <div className="small" style={{ marginTop: 6 }}>
                      เปิดโครงการแล้วกด "แก้ไข" ที่หัวหน้ารายละเอียดเพื่อใส่ชื่อ Project Co
                    </div>
                  </>
                ) : (
                  'ไม่มีโครงการที่ตรงกับตัวกรอง'
                )}
              </div>
            ) : (
              <div className="trk-list">
                {visible.map((item) => (
                  <ProjectRow key={item.row.project_id} item={item} mineName={localName} onOpen={onOpenProject} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
