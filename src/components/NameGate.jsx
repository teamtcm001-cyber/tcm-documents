import { useState } from 'react'
import Icon from './Icon.jsx'
import { setLocalName } from '../utils/localIdentity.js'

export default function NameGate({ onDone, onCancel, initialValue = '' }) {
  const [name, setName] = useState(initialValue)

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setLocalName(trimmed)
    onDone(trimmed)
  }

  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 48, height: 48, fontSize: 20 }}>
            T
          </div>
          <div>
            <h1 style={{ fontSize: 22, margin: 0 }}>TCM Document Agent</h1>
            <div className="muted small">v5 · Engineering Edition</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>ชื่อ-นามสกุล หรือ รหัสพนักงาน</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น นิธิศ ศักดิ์สิทธิการ หรือ EMP1234"
              required
              autoFocus
            />
          </div>
          <p className="muted small" style={{ marginTop: -8, marginBottom: 12 }}>
            ใช้แสดงเป็นชื่อผู้อัปโหลด/ผู้ทำรายการในระบบเท่านั้น ไม่ใช่รหัสผ่าน
          </p>
          <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
            <Icon name="arrow-r" size={15} />
            {initialValue ? 'บันทึก' : 'เริ่มใช้งาน'}
          </button>

          {onCancel && (
            <button
              type="button"
              className="link-btn"
              style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, fontSize: 12.5, color: 'var(--gray-400)', cursor: 'pointer' }}
              onClick={onCancel}
            >
              ← กลับ
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
