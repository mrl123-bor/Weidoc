import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react'

type DialogProps = {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children?: ReactNode
  /** 底部操作区；不传则只显示关闭 */
  footer?: ReactNode
  wide?: boolean
}

export function Dialog({ open, title, description, onClose, children, footer, wide }: DialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // 自动聚焦第一个输入框
    queueMicrotask(() => {
      const el = panelRef.current?.querySelector<HTMLElement>('input, textarea, button.btn.primary')
      el?.focus()
      if (el instanceof HTMLInputElement) el.select()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <div
        ref={panelRef}
        className={`dialog-panel ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p className="dialog-desc">{description}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {children ? <div className="dialog-body">{children}</div> : null}
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

type PromptDialogProps = {
  open: boolean
  title: string
  description?: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  onClose: () => void
  onConfirm: (value: string) => void | Promise<void>
}

export function PromptDialog({
  open, title, description, label = '名称', defaultValue = '', placeholder,
  confirmText = '确定', onClose, onConfirm,
}: PromptDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.value = defaultValue
    }
  }, [open, defaultValue])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = inputRef.current?.value.trim() || ''
    if (!value || busyRef.current) return
    busyRef.current = true
    try {
      await onConfirm(value)
      onClose()
    } finally {
      busyRef.current = false
    }
  }

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn soft" onClick={onClose}>取消</button>
          <button type="submit" form="weidoc-prompt-form" className="btn primary">{confirmText}</button>
        </>
      }
    >
      <form id="weidoc-prompt-form" onSubmit={(e) => void submit(e)}>
        <label className="dialog-field">
          {label}
          <input ref={inputRef} defaultValue={defaultValue} placeholder={placeholder} required />
        </label>
      </form>
    </Dialog>
  )
}

type ConfirmDialogProps = {
  open: boolean
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open, title, message, confirmText = '确定', danger, onClose, onConfirm,
}: ConfirmDialogProps) {
  const busyRef = useRef(false)

  async function go() {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await onConfirm()
      onClose()
    } finally {
      busyRef.current = false
    }
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn soft" onClick={onClose}>取消</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => void go()}>
            {confirmText}
          </button>
        </>
      }
    >
      <p className="dialog-message">{message}</p>
    </Dialog>
  )
}
