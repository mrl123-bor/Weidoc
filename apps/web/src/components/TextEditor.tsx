import { useEffect, useMemo, useState } from 'react'
import { api, type NodeItem } from '../lib/api'
import { highlightCode, langFromExt } from '../lib/mdHighlight'

type Props = {
  workspaceId: string
  node: NodeItem
  mode: 'edit' | 'view'
  onSaveState: (s: string) => void
}

export function TextEditor({ workspaceId, node, mode, onSaveState }: Props) {
  const [content, setContent] = useState('')
  const [version, setVersion] = useState(1)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    api.getContent(workspaceId, node.id).then((res) => {
      if (cancelled) return
      setContent(res.content)
      setVersion(res.version)
      setLoaded(true)
      onSaveState('已加载')
    }).catch((e) => onSaveState(e instanceof Error ? e.message : '加载失败'))
    return () => { cancelled = true }
  }, [workspaceId, node.id, onSaveState])

  useEffect(() => {
    if (!loaded || mode !== 'edit') return
    const t = window.setTimeout(() => {
      onSaveState('保存中…')
      api.putContent(workspaceId, node.id, content, version)
        .then((n) => { setVersion(n.version); onSaveState('已保存') })
        .catch((e) => onSaveState(e instanceof Error ? e.message : '保存失败'))
    }, 1000)
    return () => window.clearTimeout(t)
  }, [content, loaded, mode, workspaceId, node.id, version, onSaveState])

  const previewHtml = useMemo(
    () => highlightCode(content || '', langFromExt(node.ext)),
    [content, node.ext],
  )

  if (!loaded) return <div className="panel-card muted">加载中…</div>

  if (mode === 'view') {
    return (
      <div className="panel-card text-preview">
        <pre className="text-preview-pre">
          <code
            className={`hljs language-${langFromExt(node.ext)}`}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </pre>
      </div>
    )
  }

  return (
    <div className="panel-card text-editor">
      <textarea
        className="source"
        value={content}
        spellCheck={false}
        placeholder="在此输入文本内容…"
        onChange={(e) => {
          onSaveState('编辑中…')
          setContent(e.target.value)
        }}
      />
    </div>
  )
}
