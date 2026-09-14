import { useEffect, useState } from 'react'
import { getToken, type NodeItem } from '../lib/api'

type Props = {
  workspaceId: string
  node: NodeItem
}

function mimeForExt(ext: string, fallback = 'application/octet-stream') {
  switch (ext.toLowerCase()) {
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    default: return fallback
  }
}

export function ImageViewer({ workspaceId, node }: Props) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let objectUrl = ''
    let cancelled = false
    setUrl('')
    setErr('')
    const token = getToken()
    fetch(`/api/v1/workspaces/${workspaceId}/files/${node.id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('加载失败')
        const buf = await r.arrayBuffer()
        const type = mimeForExt(node.ext, node.mime || r.headers.get('Content-Type') || 'application/octet-stream')
        const blob = new Blob([buf], { type })
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) setUrl(objectUrl)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : '加载失败')
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [workspaceId, node.id, node.ext, node.mime, node.version])

  if (err) return <div className="panel-card muted">{err}</div>
  if (!url) return <div className="panel-card muted">加载图片…</div>
  return (
    <div className="img-frame panel-card">
      <img
        src={url}
        alt={node.name}
        onError={() => setErr('无法预览该图片（文件可能损坏或不是有效图像）')}
      />
    </div>
  )
}
