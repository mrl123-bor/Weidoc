import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ChevronDown, ChevronRight, FileText, Folder, FileSpreadsheet, FileType,
  Presentation, Image as ImageIcon, File, Trash2, Plus, Upload, FileUp,
  LogOut, Settings, Menu, Sparkles, Pencil, Copy, Download,
} from 'lucide-react'
import { api, type NodeItem } from '../lib/api'
import { downloadFile } from '../lib/download'
import { useApp, useAuth } from '../store'
import { ContentPane } from '../components/ContentPane'
import { AdminPage } from '../pages/AdminPage'
import { ConfirmDialog, PromptDialog } from '../components/ui/Dialog'
import { ContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu'

function iconFor(n: NodeItem) {
  if (n.type === 'folder') return <Folder size={15} strokeWidth={2.2} />
  switch (n.ext) {
    case 'md': case 'markdown': case 'txt': return <FileText size={15} strokeWidth={2.2} />
    case 'xlsx': case 'xls': case 'csv': return <FileSpreadsheet size={15} strokeWidth={2.2} />
    case 'docx': case 'doc': return <FileType size={15} strokeWidth={2.2} />
    case 'pptx': case 'ppt': return <Presentation size={15} strokeWidth={2.2} />
    case 'pdf': return <File size={15} strokeWidth={2.2} />
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return <ImageIcon size={15} strokeWidth={2.2} />
    default: return <File size={15} strokeWidth={2.2} />
  }
}

function typeTone(n: NodeItem) {
  if (n.type === 'folder') return 'tone-folder'
  switch (n.ext) {
    case 'md': case 'markdown': case 'txt': return 'tone-md'
    case 'xlsx': case 'xls': case 'csv': return 'tone-xls'
    case 'docx': case 'doc': return 'tone-doc'
    case 'pptx': case 'ppt': return 'tone-ppt'
    case 'pdf': return 'tone-pdf'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return 'tone-img'
    default: return 'tone-file'
  }
}

type CtxTarget = { x: number; y: number; node: NodeItem | null; parentId: string | null }
type DropPos = 'before' | 'after' | 'into'

export const IMPORT_ACCEPT = '.md,.markdown,.txt,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg'

function isOsFileDrag(e: ReactDragEvent) {
  return Array.from(e.dataTransfer.types).includes('Files')
}

function parentKey(id: string | null) {
  return id || 'root'
}

function isDescendantOf(
  nodesByParent: Record<string, NodeItem[]>,
  ancestorId: string,
  maybeChildId: string,
): boolean {
  const kids = nodesByParent[ancestorId] || []
  for (const c of kids) {
    if (c.id === maybeChildId) return true
    if (c.type === 'folder' && isDescendantOf(nodesByParent, c.id, maybeChildId)) return true
  }
  return false
}

function useTouchUi() {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(hover: none)')
    const apply = () => setTouch(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return touch
}

const SWIPE_W = 76

function TreeNode({
  node, depth, onContext, ctxNodeId, dragId, setDragId, onMove, onDropFiles, onPicked, onAskDelete, swipeId, setSwipeId, touchUi,
}: {
  node: NodeItem
  depth: number
  onContext: (e: ReactMouseEvent, node: NodeItem) => void
  ctxNodeId: string | null
  dragId: string | null
  setDragId: (id: string | null) => void
  onMove: (dragId: string, target: NodeItem, pos: DropPos) => Promise<void>
  onDropFiles: (files: FileList, target: NodeItem) => void
  onPicked?: () => void
  onAskDelete: (node: NodeItem) => void
  swipeId: string | null
  setSwipeId: (id: string | null) => void
  touchUi: boolean
}) {
  const { expanded, selectedId, toggleExpand, loadChildren, setSelected, nodesByParent } = useApp()
  const open = !!expanded[node.id]
  const children = nodesByParent[node.id] || []
  const [dropPos, setDropPos] = useState<DropPos | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [dx, setDx] = useState(0)
  const [grabbing, setGrabbing] = useState(false)
  const dxRef = useRef(0)
  const startRef = useRef<{ x: number; y: number; dx: number; mode: 'undecided' | 'h' | 'v' } | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    if (node.type === 'folder' && open && !nodesByParent[node.id]) {
      void loadChildren(node.id)
    }
  }, [open, node, loadChildren, nodesByParent])

  useEffect(() => {
    if (swipeId !== node.id && !startRef.current) {
      dxRef.current = 0
      setDx(0)
    }
  }, [swipeId, node.id])

  useEffect(() => {
    const el = rowRef.current
    if (!el || !touchUi) return
    const blockScroll = (e: TouchEvent) => {
      if (startRef.current?.mode === 'h') e.preventDefault()
    }
    el.addEventListener('touchmove', blockScroll, { passive: false })
    return () => el.removeEventListener('touchmove', blockScroll)
  }, [touchUi])

  function resolvePos(e: ReactDragEvent): DropPos {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const ratio = y / rect.height
    if (node.type === 'folder') {
      if (ratio < 0.28) return 'before'
      if (ratio > 0.72) return 'after'
      return 'into'
    }
    return ratio < 0.5 ? 'before' : 'after'
  }

  function canDropHere(draggedId: string, pos: DropPos): boolean {
    if (draggedId === node.id) return false
    if (pos === 'into') {
      if (node.type !== 'folder') return false
      if (isDescendantOf(nodesByParent, draggedId, node.id)) return false
    }
    return true
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (!touchUi) return
    if ((e.target as HTMLElement).closest('.swipe-del, .tree-more')) return
    startRef.current = {
      x: e.clientX,
      y: e.clientY,
      dx: swipeId === node.id ? -SWIPE_W : 0,
      mode: 'undecided',
    }
    movedRef.current = false
    dxRef.current = startRef.current.dx
    setDx(startRef.current.dx)
  }

  function onPointerMove(e: ReactPointerEvent) {
    const s = startRef.current
    if (!s) return
    const mx = e.clientX - s.x
    const my = e.clientY - s.y
    if (s.mode === 'undecided') {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      s.mode = Math.abs(mx) > Math.abs(my) * 1.15 ? 'h' : 'v'
      if (s.mode === 'h') {
        setGrabbing(true)
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        if (swipeId && swipeId !== node.id) setSwipeId(null)
      }
    }
    if (s.mode !== 'h') return
    movedRef.current = true
    const next = Math.max(-SWIPE_W, Math.min(0, s.dx + mx))
    dxRef.current = next
    setDx(next)
  }

  function onPointerUp() {
    const s = startRef.current
    startRef.current = null
    setGrabbing(false)
    if (!s) return
    if (s.mode === 'h') {
      if (dxRef.current <= -SWIPE_W * 0.45) {
        dxRef.current = -SWIPE_W
        setDx(-SWIPE_W)
        setSwipeId(node.id)
      } else {
        dxRef.current = 0
        setDx(0)
        if (swipeId === node.id) setSwipeId(null)
      }
    }
  }

  function onActivate() {
    if (movedRef.current) return
    if (swipeId === node.id) {
      setSwipeId(null)
      setDx(0)
      return
    }
    if (swipeId) {
      setSwipeId(null)
      return
    }
    if (node.type === 'folder') toggleExpand(node.id)
    setSelected(node.id)
    if (node.type === 'file') onPicked?.()
  }

  const offset = startRef.current ? dx : (swipeId === node.id ? -SWIPE_W : 0)

  return (
    <div>
      <div
        ref={rowRef}
        className={`swipe-row ${touchUi ? 'touch' : ''} ${grabbing || offset < -2 ? 'is-swiping' : ''} ${swipeId === node.id ? 'is-open' : ''}`}
      >
        {touchUi && (
          <button
            type="button"
            className="swipe-del"
            onClick={(e) => {
              e.stopPropagation()
              setSwipeId(null)
              setDx(0)
              onAskDelete(node)
            }}
          >
            <Trash2 size={16} />
            删除
          </button>
        )}
        <div
          className={[
            'tree-item',
            selectedId === node.id ? 'active' : '',
            ctxNodeId === node.id ? 'ctx-open' : '',
            dragId === node.id ? 'dragging' : '',
            dropPos === 'before' ? 'drop-before' : '',
            dropPos === 'after' ? 'drop-after' : '',
            dropPos === 'into' ? 'drop-into' : '',
            grabbing ? 'swiping' : '',
          ].filter(Boolean).join(' ')}
          style={{
            paddingLeft: 10 + depth * 14,
            transform: touchUi ? `translateX(${offset}px)` : undefined,
          }}
          draggable={!touchUi}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onActivate}
          onContextMenu={(e) => {
            if (touchUi) {
              e.preventDefault()
              return
            }
            onContext(e, node)
          }}
          onDragStart={(e) => {
            if (touchUi) {
              e.preventDefault()
              return
            }
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.id)
            setDragId(node.id)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDropPos(null)
          }}
          onDragOver={(e) => {
            if (isOsFileDrag(e)) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDropPos(node.type === 'folder' ? 'into' : 'after')
              return
            }
            const dragged = dragId || e.dataTransfer.getData('text/plain')
            if (!dragged) return
            const pos = resolvePos(e)
            if (!canDropHere(dragged, pos)) {
              setDropPos(null)
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropPos(pos)
          }}
          onDragLeave={() => setDropPos(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.dataTransfer.files?.length) {
              setDropPos(null)
              onDropFiles(e.dataTransfer.files, node)
              return
            }
            const dragged = dragId || e.dataTransfer.getData('text/plain')
            const pos = dropPos || resolvePos(e)
            setDropPos(null)
            setDragId(null)
            if (!dragged || !canDropHere(dragged, pos)) return
            void onMove(dragged, node, pos)
          }}
        >
          {node.type === 'folder' ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="tree-spacer" />}
          <span className={`file-badge ${typeTone(node)}`}>{iconFor(node)}</span>
          <span className="name">{node.name}</span>
          {touchUi && (
            <button
              type="button"
              className="tree-more"
              aria-label="更多"
              onClick={(e) => {
                e.stopPropagation()
                onContext(e, node)
              }}
            >
              ···
            </button>
          )}
        </div>
      </div>
      {node.type === 'folder' && open && children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth + 1}
          onContext={onContext}
          ctxNodeId={ctxNodeId}
          dragId={dragId}
          setDragId={setDragId}
          onMove={onMove}
          onDropFiles={onDropFiles}
          onPicked={onPicked}
          onAskDelete={onAskDelete}
          swipeId={swipeId}
          setSwipeId={setSwipeId}
          touchUi={touchUi}
        />
      ))}
    </div>
  )
}

type DialogState =
  | null
  | { kind: 'folder'; parentId: string | null }
  | { kind: 'rename'; node: NodeItem }
  | { kind: 'delete'; node: NodeItem }
  | { kind: 'hard-delete'; id: string; name: string; onDone: () => void }

export function AppShell() {
  const { user, logout } = useAuth()
  const {
    workspace, setWorkspace, loadChildren, nodesByParent, selectedId, setSelected,
    trashMode, setTrashMode, upsertNode, removeNodeLocal, refreshParent, toggleExpand, expanded,
  } = useApp()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<NodeItem[]>([])
  const [ctx, setCtx] = useState<CtxTarget | null>(null)
  const [view, setView] = useState<'main' | 'admin' | 'trash'>('main')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [drawerNav, setDrawerNav] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches)
  const [createOpen, setCreateOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [toast, setToast] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [swipeId, setSwipeId] = useState<string | null>(null)
  const touchUi = useTouchUi()
  const fileRef = useRef<HTMLInputElement>(null)
  const ctxUploadParent = useRef<string | null>(null)
  const ctxImportInto = useRef<string | null>(null)

  const currentParent = useMemo(() => {
    if (!selectedId) return null
    const all = Object.values(nodesByParent).flat()
    const n = all.find((x) => x.id === selectedId)
    if (!n) return null
    return n.type === 'folder' ? n.id : n.parent_id
  }, [selectedId, nodesByParent])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2200)
  }, [])

  useEffect(() => {
    api.workspaces().then((list) => {
      if (list[0]) setWorkspace(list[0])
    })
  }, [setWorkspace])

  useEffect(() => {
    if (workspace) void loadChildren(null)
  }, [workspace, loadChildren])

  useEffect(() => {
    if (!trashMode && view === 'trash') setView('main')
  }, [trashMode, view])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)')
    const apply = () => {
      setDrawerNav(mq.matches)
      if (!mq.matches) setSidebarOpen(false)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (!workspace || !q.trim()) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      api.search(workspace.id, q).then(setHits).catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, workspace])

  const closeMenus = useCallback(() => {
    setCtx(null)
    setCreateOpen(false)
  }, [])

  function openContext(e: ReactMouseEvent, node: NodeItem | null, parentId: string | null = null) {
    e.preventDefault()
    e.stopPropagation()
    setCreateOpen(false)
    // 右键只打开菜单，不改变选中项
    const pid = node
      ? (node.type === 'folder' ? node.id : node.parent_id)
      : parentId
    setCtx({ x: e.clientX, y: e.clientY, node, parentId: pid })
  }

  async function createFile(kind: 'md' | 'txt' | 'docx' | 'xlsx' | 'pptx' | 'pdf', parentId: string | null) {
    if (!workspace) return
    closeMenus()
    try {
      const n = await api.createFile(workspace.id, kind, undefined, parentId)
      if (parentId) {
        if (!expanded[parentId]) toggleExpand(parentId)
        await refreshParent(parentId)
      } else {
        upsertNode(n)
      }
      upsertNode(n)
      setSelected(n.id)
      setView('main')
      setTrashMode(false)
      if (drawerNav) setSidebarOpen(false)
      showToast(`已创建 ${n.name}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败')
    }
  }

  async function createFolderNamed(name: string, parentId: string | null) {
    if (!workspace) return
    const n = await api.createFolder(workspace.id, name, parentId)
    if (parentId) {
      if (!expanded[parentId]) toggleExpand(parentId)
      await refreshParent(parentId)
    }
    upsertNode(n)
    showToast(`已创建文件夹「${n.name}」`)
  }

  async function renameNamed(node: NodeItem, name: string) {
    if (!workspace) return
    const n = await api.rename(workspace.id, node.id, name)
    await refreshParent(node.parent_id)
    upsertNode(n)
    showToast('已重命名')
  }

  async function deleteConfirmed(node: NodeItem) {
    if (!workspace) return
    await api.remove(workspace.id, node.id)
    removeNodeLocal(node.id, node.parent_id)
    showToast('已移入回收站')
  }

  async function onUpload(files: FileList | null, parentId: string | null = currentParent) {
    if (!workspace || !files?.length) return
    try {
      let last: NodeItem | null = null
      for (const f of Array.from(files)) {
        last = await api.upload(workspace.id, f, parentId)
        upsertNode(last)
      }
      if (parentId) {
        if (!expanded[parentId]) toggleExpand(parentId)
        await refreshParent(parentId)
      }
      if (last) {
        setSelected(last.id)
        setView('main')
        setTrashMode(false)
        if (drawerNav) setSidebarOpen(false)
      }
      showToast(`已导入 ${files.length} 个文件`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败')
    }
  }

  async function onImportInto(nodeId: string, files: FileList | null) {
    if (!workspace || !files?.length) return
    const file = files[0]
    try {
      const n = await api.importInto(workspace.id, nodeId, file)
      upsertNode(n)
      setSelected(n.id)
      setView('main')
      setTrashMode(false)
      if (drawerNav) setSidebarOpen(false)
      showToast(`已导入到「${n.name}」`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败')
    }
  }

  function pickImport(parentId: string | null) {
    ctxImportInto.current = null
    ctxUploadParent.current = parentId
    fileRef.current?.click()
  }

  function pickImportInto(nodeId: string) {
    ctxImportInto.current = nodeId
    fileRef.current?.click()
  }

  function handleOsDrop(files: FileList, target: NodeItem) {
    if (target.type === 'folder') void onUpload(files, target.id)
    else void onImportInto(target.id, files)
  }

  const findNode = useCallback((id: string): NodeItem | undefined => {
    return Object.values(nodesByParent).flat().find((x) => x.id === id)
  }, [nodesByParent])

  const handleMove = useCallback(async (sourceId: string, target: NodeItem, pos: DropPos) => {
    if (!workspace) return
    const source = findNode(sourceId)
    if (!source) return

    let targetParent: string | null
    let beforeId: string | null = null

    if (pos === 'into') {
      targetParent = target.id
      beforeId = null
    } else {
      targetParent = target.parent_id
      if (pos === 'before') {
        beforeId = target.id
      } else {
        const siblings = nodesByParent[parentKey(target.parent_id)] || []
        const idx = siblings.findIndex((x) => x.id === target.id)
        beforeId = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null
        // 若下一个是自己（同级重排），取再下一个
        if (beforeId === sourceId) {
          beforeId = idx + 2 < siblings.length ? siblings[idx + 2].id : null
        }
      }
    }

    // 无变化：仍在同一父级且位置不变
    if (
      source.parent_id === targetParent &&
      pos !== 'into' &&
      ((pos === 'before' && beforeId === sourceId) ||
        (pos === 'after' && (() => {
          const siblings = nodesByParent[parentKey(source.parent_id)] || []
          const si = siblings.findIndex((x) => x.id === sourceId)
          const ti = siblings.findIndex((x) => x.id === target.id)
          return si === ti + 1
        })()))
    ) {
      return
    }

    const oldParent = source.parent_id
    try {
      await api.move(workspace.id, [sourceId], targetParent, beforeId)
      await refreshParent(oldParent)
      if (parentKey(oldParent) !== parentKey(targetParent)) {
        await refreshParent(targetParent)
      }
      if (pos === 'into' && !expanded[target.id]) toggleExpand(target.id)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移动失败')
    }
  }, [workspace, findNode, nodesByParent, refreshParent, expanded, toggleExpand, showToast])

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctx || !workspace) return []
    const canCreate = !ctx.node || ctx.node.type === 'folder'
    const parentForCreate = ctx.node?.type === 'folder' ? ctx.node.id : ctx.parentId
    const items: ContextMenuItem[] = []

    if (canCreate) {
      items.push({ type: 'label', id: 'new-label', label: '新建' })
      items.push({
        type: 'item', id: 'new-folder', label: '文件夹',
        icon: <span className="file-badge tone-folder"><Folder size={13} /></span>,
        onSelect: () => setDialog({ kind: 'folder', parentId: parentForCreate }),
      })
      items.push({
        type: 'item', id: 'new-md', label: 'Markdown 笔记',
        icon: <span className="file-badge tone-md"><FileText size={13} /></span>,
        onSelect: () => void createFile('md', parentForCreate),
      })
      items.push({
        type: 'item', id: 'new-txt', label: '纯文本 TXT',
        icon: <span className="file-badge tone-file"><FileText size={13} /></span>,
        onSelect: () => void createFile('txt', parentForCreate),
      })
      items.push({
        type: 'item', id: 'new-docx', label: 'Word 文档',
        icon: <span className="file-badge tone-doc"><FileType size={13} /></span>,
        onSelect: () => void createFile('docx', parentForCreate),
      })
      items.push({
        type: 'item', id: 'new-xlsx', label: 'Excel 表格',
        icon: <span className="file-badge tone-xls"><FileSpreadsheet size={13} /></span>,
        onSelect: () => void createFile('xlsx', parentForCreate),
      })
      items.push({
        type: 'item', id: 'new-pptx', label: 'PPT 演示',
        icon: <span className="file-badge tone-ppt"><Presentation size={13} /></span>,
        onSelect: () => void createFile('pptx', parentForCreate),
      })
      items.push({
        type: 'item', id: 'new-pdf', label: 'PDF',
        icon: <span className="file-badge tone-pdf"><File size={13} /></span>,
        onSelect: () => void createFile('pdf', parentForCreate),
      })
      items.push({
        type: 'item', id: 'upload-here', label: ctx.node?.type === 'folder' ? '导入到此文件夹' : '导入到此处',
        icon: <FileUp size={14} />,
        onSelect: () => pickImport(parentForCreate),
      })
    }

    if (ctx.node) {
      if (items.length) items.push({ type: 'sep', id: 'sep-ops' })
      if (ctx.node.type === 'file') {
        items.push({
          type: 'item', id: 'import-into', label: '用本地文件替换内容',
          icon: <Upload size={14} />,
          onSelect: () => pickImportInto(ctx.node!.id),
        })
      }
      items.push({
        type: 'item', id: 'rename', label: '重命名',
        icon: <Pencil size={14} />,
        onSelect: () => setDialog({ kind: 'rename', node: ctx.node! }),
      })
      items.push({
        type: 'item', id: 'copy', label: '复制',
        icon: <Copy size={14} />,
        onSelect: () => {
          void api.copy(workspace.id, ctx.node!.id).then((n) => {
            upsertNode(n)
            showToast('已创建副本')
          }).catch((e) => showToast(e instanceof Error ? e.message : '复制失败'))
        },
      })
      if (ctx.node.type === 'file') {
        items.push({
          type: 'item', id: 'download', label: '下载',
          icon: <Download size={14} />,
          onSelect: () => {
            void downloadFile(api.downloadUrl(workspace.id, ctx.node!.id), ctx.node!.name)
          },
        })
      }
      items.push({ type: 'sep', id: 'sep-del' })
      items.push({
        type: 'item', id: 'delete', label: '删除到回收站',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setDialog({ kind: 'delete', node: ctx.node! }),
      })
    }

    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, workspace])

  const roots = nodesByParent.root || []

  return (
    <div className="app-viewport" onClick={closeMenus}>
      <div className="bg-decor" aria-hidden>
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
        <span className="petal p1" />
        <span className="petal p2" />
        <span className="petal p3" />
        <span className="petal p4" />
        <span className="petal p5" />
      </div>

      <div className="app-shell">
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={(e) => { e.stopPropagation(); setSidebarOpen((v) => !v) }} title="目录">
            <Menu size={18} />
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden><Sparkles size={14} /></span>
            <div className="brand-text">
              <strong>微文档</strong>
              <em>WeiDoc</em>
            </div>
          </div>

          <div className="search">
            <input type="search" placeholder={drawerNav ? '搜索…' : '搜索文件名或笔记内容…'} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="topbar-actions" onClick={(e) => e.stopPropagation()}>
            <div className="create-wrap">
              <button className="btn primary" onClick={() => { setCtx(null); setCreateOpen((v) => !v) }}>
                <Plus size={16} /> <span className="btn-text">新建</span>
              </button>
              {createOpen && (
                <div className="create-menu">
                  <button onClick={() => { setCreateOpen(false); setDialog({ kind: 'folder', parentId: currentParent }) }}><span className="file-badge tone-folder"><Folder size={14} /></span> 文件夹</button>
                  <button onClick={() => void createFile('md', currentParent)}><span className="file-badge tone-md"><FileText size={14} /></span> Markdown 笔记</button>
                  <button onClick={() => void createFile('txt', currentParent)}><span className="file-badge tone-file"><FileText size={14} /></span> 纯文本 TXT</button>
                  <button onClick={() => void createFile('docx', currentParent)}><span className="file-badge tone-doc"><FileType size={14} /></span> Word</button>
                  <button onClick={() => void createFile('xlsx', currentParent)}><span className="file-badge tone-xls"><FileSpreadsheet size={14} /></span> Excel</button>
                  <button onClick={() => void createFile('pptx', currentParent)}><span className="file-badge tone-ppt"><Presentation size={14} /></span> PPT</button>
                  <button onClick={() => void createFile('pdf', currentParent)}><span className="file-badge tone-pdf"><File size={14} /></span> PDF</button>
                  <div className="create-menu-sep" />
                  <button onClick={() => { setCreateOpen(false); pickImport(currentParent) }}>
                    <span className="file-badge tone-file"><FileUp size={14} /></span> 从本地导入…
                  </button>
                </div>
              )}
            </div>
            <button className="btn soft phone-hide" onClick={() => pickImport(currentParent)} title="把本地 Word / Excel / MD / PPT / PDF 导入为新文件">
              <FileUp size={15} /> <span className="btn-text">导入</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={IMPORT_ACCEPT}
              onChange={(e) => {
                const files = e.target.files
                const into = ctxImportInto.current
                ctxImportInto.current = null
                if (into) void onImportInto(into, files)
                else void onUpload(files, ctxUploadParent.current)
                e.target.value = ''
              }}
            />

            <div className="user-chip phone-hide" title={user?.username}>
              <span className="user-chip-avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
              <span className="user-name">{user?.username}</span>
            </div>
            {user?.role === 'admin' && (
              <button className="icon-btn phone-hide" onClick={() => setView('admin')} title="设置"><Settings size={16} /></button>
            )}
            <button className="icon-btn phone-hide" onClick={() => void logout()} title="退出"><LogOut size={16} /></button>
          </div>
        </header>

        {view === 'admin' ? (
          <AdminPage onBack={() => setView('main')} />
        ) : (
          <div className="main">
            {sidebarOpen && (
              <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
            )}
            <aside
              className={`sidebar ${sidebarOpen ? 'open' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                // 空白处右键：在根目录新建
                if ((e.target as HTMLElement).closest('.tree-item')) return
                openContext(e, null, null)
              }}
            >
              <div className="sidebar-head">
                <div>
                  <div className="sidebar-title">文件柜</div>
                  <div className="sidebar-sub">{workspace?.name || '个人空间'}</div>
                </div>
                <button
                  className={`chip-btn ${trashMode || view === 'trash' ? 'active' : ''}`}
                  onClick={() => {
                    closeMenus()
                    if (drawerNav) setSidebarOpen(false)
                    if (trashMode || view === 'trash') {
                      setView('main')
                      setTrashMode(false)
                    } else {
                      setView('trash')
                      setTrashMode(true)
                    }
                  }}
                >
                  <Trash2 size={13} /> 回收站
                </button>
              </div>
              <div className="sidebar-search">
                <input type="search" placeholder="搜索文件名或笔记…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>

              <div className="quick-row">
                <button className="quick-card tone-md" onClick={() => void createFile('md', currentParent)}><FileText size={16} /><span>笔记</span></button>
                <button className="quick-card tone-doc" onClick={() => void createFile('docx', currentParent)}><FileType size={16} /><span>Word</span></button>
                <button className="quick-card tone-xls" onClick={() => void createFile('xlsx', currentParent)}><FileSpreadsheet size={16} /><span>表格</span></button>
                <button className="quick-card tone-ppt" onClick={() => void createFile('pptx', currentParent)}><Presentation size={16} /><span>幻灯</span></button>
              </div>

              <div className="tree-label">{touchUi ? '文件库 · 左滑删除 · 点 ··· 更多' : '文件库 · 拖入本地文件可导入'}</div>
              <div
                className="tree"
                onScroll={() => { closeMenus(); setSwipeId(null) }}
                onDragOver={(e) => {
                  if (!isOsFileDrag(e)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.files?.length) return
                  e.preventDefault()
                  void onUpload(e.dataTransfer.files, currentParent)
                }}
              >
                {q.trim() ? (
                  hits.length ? hits.map((n) => (
                    <div
                      key={n.id}
                      className={`tree-item ${selectedId === n.id ? 'active' : ''} ${ctx?.node?.id === n.id ? 'ctx-open' : ''}`}
                      onClick={() => { setSelected(n.id); setView('main'); setTrashMode(false); setSidebarOpen(false); closeMenus() }}
                      onContextMenu={(e) => openContext(e, n)}
                    >
                      <span className={`file-badge ${typeTone(n)}`}>{iconFor(n)}</span>
                      <span className="name">{n.name}</span>
                    </div>
                  )) : <div className="muted tree-empty">没有匹配结果</div>
                ) : roots.length ? (
                  roots.map((n) => (
                    <TreeNode
                      key={n.id}
                      node={n}
                      depth={0}
                      onContext={(e, node) => openContext(e, node)}
                      ctxNodeId={ctx?.node?.id ?? null}
                      dragId={dragId}
                      setDragId={setDragId}
                      onMove={handleMove}
                      onDropFiles={handleOsDrop}
                      onPicked={() => { if (drawerNav) setSidebarOpen(false) }}
                      onAskDelete={(node) => setDialog({ kind: 'delete', node })}
                      swipeId={swipeId}
                      setSwipeId={setSwipeId}
                      touchUi={touchUi}
                    />
                  ))
                ) : (
                  <div className="muted tree-empty">还没有文件，点「导入」或把本地文件拖到这里</div>
                )}
              </div>
              <div className="sidebar-foot">
                <div className="user-chip" title={user?.username}>
                  <span className="user-chip-avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="user-name">{user?.username}</span>
                </div>
                <div className="sidebar-foot-actions">
                  {user?.role === 'admin' && (
                    <button className="icon-btn" onClick={() => { setView('admin'); setSidebarOpen(false) }} title="设置"><Settings size={16} /></button>
                  )}
                  <button className="icon-btn" onClick={() => void logout()} title="退出"><LogOut size={16} /></button>
                </div>
              </div>
            </aside>

            <section className="content" onClick={closeMenus}>
              {trashMode || view === 'trash' ? (
                <TrashPane
                  onBack={() => { setView('main'); setTrashMode(false) }}
                  onRestored={() => { void loadChildren(null) }}
                  onConfirmHardDelete={(id, name, onDone) => setDialog({ kind: 'hard-delete', id, name, onDone })}
                />
              ) : (
                <ContentPane onImportLocal={(id) => pickImportInto(id)} />
              )}
            </section>
          </div>
        )}
      </div>

      {ctx && ctxItems.length > 0 && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={() => setCtx(null)} />
      )}

      <PromptDialog
        open={dialog?.kind === 'folder'}
        title="新建文件夹"
        description="给文件夹起一个好认的名字"
        label="文件夹名称"
        defaultValue="新建文件夹"
        confirmText="创建"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          if (dialog?.kind !== 'folder') return
          await createFolderNamed(name, dialog.parentId)
        }}
      />

      <PromptDialog
        open={dialog?.kind === 'rename'}
        title="重命名"
        label="新名称"
        defaultValue={dialog?.kind === 'rename' ? dialog.node.name : ''}
        confirmText="保存"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          if (dialog?.kind !== 'rename') return
          await renameNamed(dialog.node, name)
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="移入回收站"
        message={dialog?.kind === 'delete' ? `确定将「${dialog.node.name}」移入回收站？之后可在回收站还原。` : ''}
        confirmText="删除"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return
          await deleteConfirmed(dialog.node)
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'hard-delete'}
        title="彻底删除"
        message={dialog?.kind === 'hard-delete' ? `确定彻底删除「${dialog.name}」？此操作不可恢复。` : ''}
        confirmText="彻底删除"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'hard-delete' || !workspace) return
          await api.hardDelete(workspace.id, dialog.id)
          dialog.onDone()
          showToast('已彻底删除')
        }}
      />

      {toast && <div className="app-toast">{toast}</div>}
    </div>
  )
}

function TrashPane({
  onBack,
  onRestored,
  onConfirmHardDelete,
}: {
  onBack: () => void
  onRestored?: () => void
  onConfirmHardDelete: (id: string, name: string, onDone: () => void) => void
}) {
  const { workspace } = useApp()
  const [list, setList] = useState<NodeItem[]>([])

  async function reload() {
    if (!workspace) return
    setList(await api.trash(workspace.id))
  }

  useEffect(() => { void reload() }, [workspace])

  if (!workspace) return null

  return (
    <>
      <div className="content-toolbar">
        <strong>回收站</strong>
        <button type="button" className="btn soft" onClick={onBack}>返回文档</button>
      </div>
      <div className="content-body">
        <div className="panel-card">
          {list.length === 0 ? (
            <div className="empty-inline">回收站空空如也</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th align="left">名称</th><th align="left">删除时间</th><th></th></tr>
              </thead>
              <tbody>
                {list.map((n) => (
                  <tr key={n.id}>
                    <td>{n.name}</td>
                    <td className="muted">{n.deleted_at}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn soft" onClick={() => void api.restore(workspace.id, n.id).then(() => { void reload(); onRestored?.() })}>还原</button>{' '}
                      <button
                        className="btn danger"
                        onClick={() => onConfirmHardDelete(n.id, n.name, () => void reload())}
                      >
                        彻底删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}
