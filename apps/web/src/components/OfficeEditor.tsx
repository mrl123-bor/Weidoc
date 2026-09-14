import { useEffect, useRef, useState } from 'react'
import { api, getToken, type NodeItem } from '../lib/api'

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (id: string, config: Record<string, unknown>) => {
        destroyEditor?: () => void
      }
    }
  }
}

type Props = {
  workspaceId: string
  node: NodeItem
  mode: 'edit' | 'view'
}

/**
 * OnlyOffice 会直接改写挂载节点的 DOM。
 * 因此该节点必须由我们手动创建/清空，绝不能交给 React 做子节点 reconciliation。
 */
export function OfficeEditor({ workspaceId, node, mode }: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<{ destroyEditor?: () => void } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const shell = shellRef.current
    if (!shell) return

    setLoading(true)
    setError('')

    const placeholderId = `oo-${node.id}-${mode}-${Date.now()}`
    const host = document.createElement('div')
    host.id = placeholderId
    host.style.width = '100%'
    host.style.height = '100%'
    shell.innerHTML = ''
    shell.appendChild(host)

    async function boot() {
      try {
        const cfg = await api.officeSession(workspaceId, node.id, mode)
        if (cancelled) return
        await loadScript(cfg.docs_api_script)
        if (cancelled) return
        if (!window.DocsAPI) throw new Error('DocsAPI 未加载，请检查 ONLYOFFICE 服务')

        // 销毁旧实例（StrictMode 二次挂载时）
        try {
          editorRef.current?.destroyEditor?.()
        } catch {
          /* ignore */
        }

        const config: Record<string, unknown> = {
          documentType: cfg.documentType,
          document: cfg.document,
          editorConfig: {
            ...cfg.editorConfig,
            // 避免 OnlyOffice 注入 unload 监听触发控制台 violation
          },
          token: cfg.token,
          width: '100%',
          height: '100%',
          events: {
            onAppReady: () => {
              if (!cancelled) setLoading(false)
            },
            onError: (event: unknown) => {
              if (!cancelled) setError(formatOfficeError(event))
            },
          },
        }

        editorRef.current = new window.DocsAPI.DocEditor(placeholderId, config)
        // 兜底：部分版本不触发 onAppReady
        window.setTimeout(() => {
          if (!cancelled) setLoading(false)
        }, 2500)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : formatOfficeError(e))
          setLoading(false)
        }
      }
    }

    void boot()

    const renew = window.setInterval(() => {
      if (mode !== 'edit') return
      const token = getToken()
      if (!token) return
      fetch(`/api/v1/workspaces/${workspaceId}/files/${node.id}/lock/renew`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }, 10 * 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(renew)
      try {
        editorRef.current?.destroyEditor?.()
      } catch {
        /* ignore */
      }
      editorRef.current = null
      // 关键关键：清空容器，防止 React 后续更新撞上 OnlyOffice 留下的节点
      if (shell) shell.innerHTML = ''

      if (mode === 'edit') {
        const token = getToken()
        if (token) {
          fetch(`/api/v1/workspaces/${workspaceId}/files/${node.id}/lock`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => undefined)
        }
      }
    }
  }, [workspaceId, node.id, mode])

  if (error) {
    return (
      <div className="panel-card">
        <h3>无法打开 Office 文档</h3>
        <p className="error">{error}</p>
        <p className="muted">
          请确认 ONLYOFFICE 已启动且三方可互通。若是系统内「新建」的旧 Office 文件，请删除后重新新建（旧空白模板不兼容）。
        </p>
      </div>
    )
  }

  return (
    <div className="panel-card" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
      {loading && (
        <div className="muted" style={{ position: 'absolute', zIndex: 2, padding: 16 }}>
          正在加载编辑器…
        </div>
      )}
      {/* React 只拥有这个空壳；内部 DOM 完全由 OnlyOffice 管理 */}
      <div ref={shellRef} className="office-frame" />
    </div>
  )
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null
    if (existing) {
      if (window.DocsAPI) {
        resolve()
        return
      }
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('加载 ONLYOFFICE api.js 失败')), { once: true })
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('加载 ONLYOFFICE api.js 失败'))
    document.head.appendChild(s)
  })
}

/** OnlyOffice onError 常返回对象（含 ServerCode/ServerDescription），不能直接当 React 子节点。 */
function formatOfficeError(event: unknown): string {
  if (event == null) return '编辑器内部错误'
  if (typeof event === 'string') return event
  if (typeof event === 'object') {
    const root = event as Record<string, unknown>
    const data = (root.data ?? root) as Record<string, unknown>
    const msg =
      data.ServerDescription ||
      data.errorDescription ||
      data.message ||
      data.error ||
      root.ServerDescription ||
      root.message
    if (typeof msg === 'string' && msg.trim()) return msg
    try {
      return JSON.stringify(data)
    } catch {
      return '编辑器内部错误'
    }
  }
  return String(event)
}
