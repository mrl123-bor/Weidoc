import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type ContextMenuItem =
  | { type: 'item'; id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'sep'; id: string }
  | { type: 'label'; id: string; label: string }

type Props = {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad)
    if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad)
    setPos({ left, top })
  }, [x, y, items])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: MouseEvent | PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // 下一帧再监听，避免打开菜单的同一次右键立刻关掉
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', onPointer, true)
      window.addEventListener('contextmenu', onPointer, true)
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', close)
      window.addEventListener('blur', close)
      window.addEventListener('scroll', close, true)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onPointer, true)
      window.removeEventListener('contextmenu', onPointer, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => {
        if (it.type === 'sep') return <div key={it.id} className="ctx-sep" />
        if (it.type === 'label') return <div key={it.id} className="ctx-label">{it.label}</div>
        return (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onSelect()
            }}
          >
            {it.icon ? <span className="ctx-icon">{it.icon}</span> : null}
            <span>{it.label}</span>
          </button>
        )
      })}
    </div>
  )
}
