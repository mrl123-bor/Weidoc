import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Download, MoreHorizontal } from 'lucide-react'
import { api, type NodeItem } from '../lib/api'
import { downloadFile } from '../lib/download'
import { useApp } from '../store'
import {
  MarkdownEditor,
  OutlineMenu,
  type MarkdownEditorHandle,
  type OutlineItem,
} from './MarkdownEditor'
import { OfficeEditor } from './OfficeEditor'
import { PdfViewer } from './PdfViewer'
import { TextEditor } from './TextEditor'
import { ImageViewer } from './ImageViewer'

function findNode(nodesByParent: Record<string, NodeItem[]>, id: string | null) {
  if (!id) return null
  for (const list of Object.values(nodesByParent)) {
    const n = list.find((x) => x.id === id)
    if (n) return n
  }
  return null
}

export function ContentPane({ onImportLocal }: { onImportLocal?: (nodeId: string) => void }) {
  const { workspace, selectedId, nodesByParent } = useApp()
  const node = useMemo(() => findNode(nodesByParent, selectedId), [nodesByParent, selectedId])
  const [mode, setMode] = useState<'edit' | 'view'>('edit')
  const [saveState, setSaveState] = useState('')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const mdRef = useRef<MarkdownEditorHandle>(null)
  const toggleToc = useCallback(() => setTocOpen((v) => !v), [])

  useEffect(() => {
    if (!node) return
      setTocOpen(false)
      setMoreOpen(false)
      setOutline([])
    if (node.ext === 'pdf' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(node.ext)) {
      setMode('view')
    } else {
      setMode('edit')
    }
  }, [node?.id])

  const onOutlineChange = useCallback((items: OutlineItem[]) => {
    setOutline(items)
  }, [])

  if (!workspace || !node) {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-illus" aria-hidden />
          <h2>选择、新建或导入一个文件</h2>
          <p>把本地 Word / Excel / Markdown / PPT / PDF 拖到左侧目录，或点顶栏「导入」</p>
        </div>
      </div>
    )
  }

  if (node.type === 'folder') {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-illus" aria-hidden />
          <h2>{node.name}</h2>
          <p className="muted">这是一个文件夹。可在左侧展开，或把本地文件拖进来导入</p>
        </div>
      </div>
    )
  }

  const isMd = node.ext === 'md' || node.ext === 'markdown'
  const isText = ['txt', 'json', 'yaml', 'yml', 'css', 'js', 'ts', 'csv'].includes(node.ext)
  const isOffice = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(node.ext)
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(node.ext)

  return (
    <>
      <div className="content-toolbar">
        <strong title={node.name}>{node.name}</strong>
        {(isMd || isOffice || isText) && (
          <div className="mode-tabs">
            <button className={`btn ${mode === 'view' ? 'primary' : ''}`} onClick={() => setMode('view')}>预览</button>
            <button className={`btn ${mode === 'edit' ? 'primary' : ''}`} onClick={() => setMode('edit')}>编辑</button>
          </div>
        )}
        {saveState && <span className="save-pill phone-hide">{saveState}</span>}
        <div className="toolbar-right">
          {isMd && (
            <OutlineMenu
              items={outline}
              open={tocOpen}
              onToggle={toggleToc}
              onJump={(idx) => mdRef.current?.jumpToHeading(idx)}
            />
          )}
          {onImportLocal && (
            <button className="btn soft phone-hide" type="button" onClick={() => onImportLocal(node.id)}>
              <FileUp size={14} /> 导入内容
            </button>
          )}
          <a className="btn soft phone-hide" href="#" onClick={(e) => {
            e.preventDefault()
            void downloadFile(api.downloadUrl(workspace.id, node.id), node.name)
          }}>下载</a>
          <div className="more-wrap phone-only">
            <button
              type="button"
              className="icon-btn"
              title="更多"
              onClick={(e) => { e.stopPropagation(); setMoreOpen((v) => !v) }}
            >
              <MoreHorizontal size={18} />
            </button>
            {moreOpen && (
              <div className="create-menu" onClick={(e) => e.stopPropagation()}>
                {onImportLocal && (
                  <button onClick={() => { setMoreOpen(false); onImportLocal(node.id) }}>
                    <FileUp size={14} /> 导入内容
                  </button>
                )}
                <button onClick={() => {
                  setMoreOpen(false)
                  void downloadFile(api.downloadUrl(workspace.id, node.id), node.name)
                }}>
                  <Download size={14} /> 下载
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={`content-body ${isOffice || isImage ? 'fill-editor' : ''}`}>
        {isMd && (
          <MarkdownEditor
            key={`${node.id}-${node.version}`}
            ref={mdRef}
            workspaceId={workspace.id}
            node={node}
            mode={mode}
            onSaveState={setSaveState}
            onOutlineChange={onOutlineChange}
          />
        )}
        {isText && !isMd && (
          <TextEditor
            key={`${node.id}-${node.version}`}
            workspaceId={workspace.id}
            node={node}
            mode={mode}
            onSaveState={setSaveState}
          />
        )}
        {isOffice && node.ext === 'pdf' && mode === 'view' && (
          <PdfViewer workspaceId={workspace.id} node={node} />
        )}
        {isOffice && !(node.ext === 'pdf' && mode === 'view') && (
          <OfficeEditor
            key={`${node.id}-${mode}-${node.version}`}
            workspaceId={workspace.id}
            node={node}
            mode={mode}
          />
        )}
        {isImage && <ImageViewer workspaceId={workspace.id} node={node} />}
        {!isMd && !isText && !isOffice && !isImage && (
          <div className="panel-card">
            <p>暂不支持在线预览该类型，请下载后打开。</p>
            <p className="muted">大小：{(node.size_bytes / 1024).toFixed(1)} KB</p>
          </div>
        )}
      </div>
    </>
  )
}
