import { useEffect, useState } from 'react'
import { getToken, type NodeItem } from '../lib/api'

type Props = {
  workspaceId: string
  node: NodeItem
}

export function PdfViewer({ workspaceId, node }: Props) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    // Use authenticated fetch -> blob URL so <iframe>/embed works with bearer auth
    const token = getToken()
    fetch(`/api/v1/workspaces/${workspaceId}/files/${node.id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.blob())
      .then((b) => setUrl(URL.createObjectURL(b)))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [workspaceId, node.id])

  if (!url) return <div className="panel-card muted">加载 PDF…</div>
  return <iframe className="pdf-frame" title={node.name} src={url} />
}
