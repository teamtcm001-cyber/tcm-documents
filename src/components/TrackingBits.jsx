import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { TRACKING_NOT_INSTALLED_MESSAGE } from '../api/supabase.js'
import {
  HEALTH_LABEL, STALE_DAYS, BEHIND_POINTS, READY_TO_BILL_DAYS, DUE_SOON_DAYS,
} from '../utils/tracking.js'

// Small presentational pieces shared by the tracking screens.

const HEALTH_ICON = { red: 'alert', amber: 'alert', green: 'circle-check' }

// Colour AND icon AND text, so it never relies on colour alone.
export function HealthChip({ level, size = 'md' }) {
  return (
    <span className={`trk-health trk-health-${level} ${size === 'lg' ? 'lg' : ''}`}>
      <Icon name={HEALTH_ICON[level]} size={size === 'lg' ? 16 : 14} />
      {HEALTH_LABEL[level]}
    </span>
  )
}

export function ToneBadge({ tone = 'mute', children, title }) {
  return (
    <span className={`trk-badge trk-tone-${tone}`} title={title}>
      {children}
    </span>
  )
}

// Bar = % complete, tick = time elapsed %. Both whole numbers.
export function ProgressMeter({ percent, elapsed, tall = false }) {
  const label =
    `ความคืบหน้า ${percent == null ? 'ยังไม่เคยอัปเดต' : `${percent}%`}` +
    (elapsed == null ? ' ยังไม่ระบุวันที่สัญญา' : ` เวลาผ่านไป ${elapsed}%`)
  return (
    <div className={`trk-meter ${tall ? 'tall' : ''}`} role="img" aria-label={label}>
      <div className="trk-meter-bar">
        {percent != null && <div className="trk-meter-fill" style={{ width: `${percent}%` }} />}
        {elapsed != null && (
          <div className="trk-meter-mark" style={{ left: `${elapsed}%` }} title={`เวลาผ่านไป ${elapsed}%`} />
        )}
      </div>
    </div>
  )
}

export function MeterLegend({ percent, elapsed }) {
  return (
    <div className="trk-legend">
      <span>
        <i className="sw fill" /> คืบหน้า <b>{percent == null ? '-' : `${percent}%`}</b>
      </span>
      <span>
        <i className="sw mark" /> เวลาผ่านไป <b>{elapsed == null ? '-' : `${elapsed}%`}</b>
      </span>
    </div>
  )
}

export function NotInstalledNotice({ onRetry }) {
  return (
    <div className="trk-notice" role="alert">
      <Icon name="info" size={22} />
      <div>
        <div className="trk-notice-title">ยังไม่ได้ติดตั้งโครงสร้างข้อมูลติดตามงาน</div>
        <div className="trk-notice-text">
          {TRACKING_NOT_INSTALLED_MESSAGE.replace('ยังไม่ได้ติดตั้งโครงสร้างข้อมูลติดตามงาน — ', '')}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          ส่วนอื่นของระบบ (เอกสาร / ถามหาเอกสาร) ใช้งานได้ตามปกติ
        </div>
        {onRetry && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={onRetry}>
            <Icon name="refresh" size={14} /> ตรวจสอบอีกครั้ง
          </button>
        )}
      </div>
    </div>
  )
}

export function ErrorNotice({ message, onRetry }) {
  return (
    <div className="trk-notice trk-notice-err" role="alert">
      <Icon name="alert" size={22} />
      <div>
        <div className="trk-notice-title">โหลดข้อมูลไม่สำเร็จ</div>
        <div className="trk-notice-text">{message || 'ไม่ทราบสาเหตุ'}</div>
        {onRetry && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={onRetry}>
            <Icon name="refresh" size={14} /> ลองใหม่
          </button>
        )}
      </div>
    </div>
  )
}

// Small, non-blocking: shown when part of the overview data failed to load,
// so a green chip is not mistaken for a complete health check.
export function PartialDataNotice({ onRetry }) {
  return (
    <div className="trk-partial" role="status">
      <Icon name="alert" size={15} />
      <span>ข้อมูลบางส่วนโหลดไม่ครบ — สถานะอาจไม่สมบูรณ์ กดรีเฟรช</span>
      {onRetry && (
        <button type="button" className="trk-link-btn" onClick={onRetry}>
          <Icon name="refresh" size={13} /> รีเฟรช
        </button>
      )}
    </div>
  )
}

// "ดูเกณฑ์" popover: toggled by button, closes on Escape / outside click.
export function CriteriaPopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span className="trk-pop-wrap" ref={ref}>
      <button
        type="button"
        className="trk-link-btn"
        aria-expanded={open}
        aria-controls="trk-criteria"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="info" size={14} /> ดูเกณฑ์
      </button>
      {open && (
        <div className="trk-pop" id="trk-criteria" role="dialog" aria-label="เกณฑ์สถานะโครงการ">
          <div className="trk-pop-title">เกณฑ์สถานะ (ไม่มีตัวเลขเงิน — ดูจากสถานะ วันที่ และเอกสารเท่านั้น)</div>
          <div className="trk-pop-sec">
            <HealthChip level="red" />
            <ul>
              <li>มีงวดที่ยังไม่เบิก และเลยวันที่กำหนดเบิกแล้ว</li>
              <li>ความคืบหน้า (%) ตามหลังเวลาที่ผ่านไป (%) เกิน {BEHIND_POINTS} จุด</li>
            </ul>
          </div>
          <div className="trk-pop-sec">
            <HealthChip level="amber" />
            <ul>
              <li>สถานะ "พร้อมเบิก" ค้างเกิน {READY_TO_BILL_DAYS} วัน</li>
              <li>งวดถัดไปครบกำหนดภายใน {DUE_SOON_DAYS} วัน แต่เอกสารจำเป็นยังขาด</li>
              <li>ไม่ได้อัปเดต % เกิน {STALE_DAYS} วัน หรือยังไม่เคยอัปเดต</li>
            </ul>
          </div>
          <div className="trk-pop-sec">
            <HealthChip level="green" />
            <ul>
              <li>ไม่เข้าเงื่อนไขข้างต้น</li>
            </ul>
          </div>
          <div className="muted small">
            โครงการสถานะ "ปิดโครงการ" ไม่นับเงื่อนไขความคืบหน้า/การอัปเดต % แต่ยังตรวจงวดเบิกตามปกติ ·
            โครงการที่ยังไม่ระบุวันที่สัญญาจะเทียบความคืบหน้ากับเวลาไม่ได้
          </div>
        </div>
      )}
    </span>
  )
}
