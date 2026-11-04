import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon.jsx'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Accessible modal: role=dialog + aria-modal + aria-labelledby, focus moves inside on open and
// returns to the opener on close, Tab is trapped, Escape closes (unless `closable` is false).
// Rendered in a portal so a dialog can safely sit on top of another dialog.
export default function Dialog({
  title,
  onClose,
  closable = true,
  size, // 'sm' | 'md' | 'lg'
  children,
  footer,
  initialFocus, // CSS selector inside the dialog; default = first focusable
  describedBy,
  className = '',
}) {
  const rootRef = useRef(null)
  const titleId = useId()
  // the element that had focus when the dialog was rendered (children focus their own fields before any effect here runs)
  const openerRef = useRef(undefined)
  if (openerRef.current === undefined) openerRef.current = typeof document !== 'undefined' ? document.activeElement : null

  useEffect(() => {
    const opener = openerRef.current
    const root = rootRef.current
    // a child may already have focused its own field (children's effects run first): keep that
    if (root && root.contains(document.activeElement) && document.activeElement !== root) {
      return () => {
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
      }
    }
    const target = (initialFocus && root?.querySelector(initialFocus)) || root?.querySelector('[data-autofocus]') || root?.querySelector(FOCUSABLE)
    ;(target || root)?.focus()
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (closable) onClose?.()
      return
    }
    if (e.key !== 'Tab') return
    e.stopPropagation() // a dialog on top of another one handles its own focus trap
    const nodes = Array.from(rootRef.current.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement)
    if (nodes.length === 0) {
      e.preventDefault()
      return
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (closable && e.target === e.currentTarget) onClose?.()
      }}
    >
      <div
        ref={rootRef}
        className={`modal dlg ${size ? `dlg-${size}` : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          {closable && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="ปิด" title="ปิด">
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

// Yes/no confirmation for destructive or security-relevant actions.
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'ยืนยัน',
  cancelLabel = 'ยกเลิก',
  danger = false,
  busy = false,
  error = '',
  onConfirm,
  onCancel,
}) {
  const bodyId = useId()
  return (
    <Dialog
      title={title}
      onClose={busy ? undefined : onCancel}
      closable={!busy}
      size="sm"
      describedBy={bodyId}
      initialFocus="[data-cancel]"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy} data-cancel>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'กำลังดำเนินการ...' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="modal-body" id={bodyId}>
        {children}
        {error && (
          <div className="auth-msg err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
