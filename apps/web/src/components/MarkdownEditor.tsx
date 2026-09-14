import { useCallback, useEffect, useRef, useState, type ReactNode, forwardRef, useImperativeHandle, useMemo } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table/kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import TurndownService from 'turndown'
import DOMPurify from 'dompurify'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo, Quote, Code, Code2,
  Link2, ImagePlus, Upload, Table2, Minus, Undo2, Redo2,
  Pilcrow, ListTree,
} from 'lucide-react'
import { api, type NodeItem } from '../lib/api'
import { CODE_LANGS, lowlight, markedPlain, markedPretty } from '../lib/mdHighlight'
import { ConfirmDialog, PromptDialog } from './ui/Dialog'

export type OutlineItem = { id: string; level: number; text: string }

export type MarkdownEditorHandle = {
  jumpToHeading: (index: number) => void
  getOutline: () => OutlineItem[]
}

function extractOutline(md: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const re = /^(#{1,3})\s+(.+?)\s*$/gm
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(md || ''))) {
    const text = m[2].replace(/\s+#+\s*$/, '').replace(/[*_`]/g, '').trim()
    if (!text) continue
    items.push({ id: `toc-${i++}`, level: m[1].length, text })
  }
  return items
}

function mdToHtmlWithIds(md: string) {
  let i = 0
  const raw = markedPretty.parse(md || '') as string
  const html = raw.replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_all, level, attrs, inner) => {
    const id = `toc-${i++}`
    if (/\sid=/.test(attrs)) return `<h${level}${attrs}>${inner}</h${level}>`
    return `<h${level}${attrs} id="${id}">${inner}</h${level}>`
  })
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['checked', 'data-checked', 'id', 'class'],
  })
}

type Props = {
  workspaceId: string
  node: NodeItem
  mode: 'edit' | 'view'
  onSaveState: (s: string) => void
  onOutlineChange?: (items: OutlineItem[]) => void
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
})

turndown.addRule('highlightedCodeBlock', {
  filter: (node) => {
    return node.nodeName === 'PRE' && !!node.firstChild && (node.firstChild as HTMLElement).nodeName === 'CODE'
  },
  replacement: (_content, node) => {
    const code = (node as HTMLElement).querySelector('code')
    const text = code?.textContent ?? ''
    const cls = code?.getAttribute('class') || ''
    const lang = (cls.match(/(?:language|lang)-([\w+-]+)/) || [])[1] || ''
    const body = text.replace(/\n$/, '')
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`
  },
})

turndown.addRule('strikethrough', {
  filter: ['del', 's'] as unknown as TurndownService.Filter,
  replacement: (content) => `~~${content}~~`,
})

turndown.addRule('underline', {
  filter: ['u'] as unknown as TurndownService.Filter,
  replacement: (content) => `<u>${content}</u>`,
})

turndown.addRule('taskListItem', {
  filter: (node) => {
    if (node.nodeName !== 'LI') return false
    const el = node as HTMLElement
    return el.getAttribute('data-checked') != null || !!el.querySelector?.('input[type="checkbox"]')
  },
  replacement: (content, node) => {
    const el = node as HTMLElement
    const checked =
      el.getAttribute('data-checked') === 'true' ||
      !!(el.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked
    const text = content.replace(/^\s*\[[ xX]\]\s*/, '').trim()
    return `- [${checked ? 'x' : ' '}] ${text}\n`
  },
})

function mdToHtml(md: string) {
  return DOMPurify.sanitize(markedPlain.parse(md || '') as string, {
    ADD_ATTR: ['checked', 'data-checked', 'id', 'class'],
  })
}

function htmlToMd(html: string) {
  return turndown.turndown(html || '').trim() + '\n'
}

function ToolBtn({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`md-tool ${active ? 'active' : ''}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="md-sep" aria-hidden />
}

function useEditorTick(editor: Editor | null) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!editor) return
    const bump = () => setTick((t) => t + 1)
    editor.on('selectionUpdate', bump)
    editor.on('transaction', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('transaction', bump)
    }
  }, [editor])
}

function Toolbar({
  editor,
  disabled,
}: {
  editor: Editor
  disabled?: boolean
}) {
  useEditorTick(editor)
  const fileRef = useRef<HTMLInputElement>(null)
  const [prompt, setPrompt] = useState<null | { type: 'link' | 'image'; value: string }>(null)
  const [alertMsg, setAlertMsg] = useState('')

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    setPrompt({ type: 'link', value: prev || 'https://' })
  }

  const insertImageUrl = () => {
    setPrompt({ type: 'image', value: 'https://' })
  }

  const onPickImage = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setAlertMsg('图片请小于 2MB，更大的文件请用「图片链接」。')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result || '')
      if (src) editor.chain().focus().setImage({ src, alt: file.name }).run()
    }
    reader.readAsDataURL(file)
  }

  return (
    <>
      <div className="md-toolbar">
      <ToolBtn title="撤销" disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 size={15} />
      </ToolBtn>
      <ToolBtn title="重做" disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 size={15} />
      </ToolBtn>
      <Sep />
      <ToolBtn title="正文" active={editor.isActive('paragraph')} disabled={disabled} onClick={() => editor.chain().focus().setParagraph().run()}>
        <Pilcrow size={15} />
      </ToolBtn>
      <ToolBtn title="一级标题" active={editor.isActive('heading', { level: 1 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={15} />
      </ToolBtn>
      <ToolBtn title="二级标题" active={editor.isActive('heading', { level: 2 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={15} />
      </ToolBtn>
      <ToolBtn title="三级标题" active={editor.isActive('heading', { level: 3 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={15} />
      </ToolBtn>
      <Sep />
      <ToolBtn title="粗体 Ctrl+B" active={editor.isActive('bold')} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={15} />
      </ToolBtn>
      <ToolBtn title="斜体 Ctrl+I" active={editor.isActive('italic')} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={15} />
      </ToolBtn>
      <ToolBtn title="下划线" active={editor.isActive('underline')} disabled={disabled} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon size={15} />
      </ToolBtn>
      <ToolBtn title="删除线" active={editor.isActive('strike')} disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={15} />
      </ToolBtn>
      <ToolBtn title="行内代码" active={editor.isActive('code')} disabled={disabled} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={15} />
      </ToolBtn>
      <Sep />
      <ToolBtn title="无序列表" active={editor.isActive('bulletList')} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={15} />
      </ToolBtn>
      <ToolBtn title="有序列表" active={editor.isActive('orderedList')} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={15} />
      </ToolBtn>
      <ToolBtn title="任务列表" active={editor.isActive('taskList')} disabled={disabled} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListTodo size={15} />
      </ToolBtn>
      <ToolBtn title="引用" active={editor.isActive('blockquote')} disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote size={15} />
      </ToolBtn>
      <ToolBtn title="代码块" active={editor.isActive('codeBlock')} disabled={disabled} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code2 size={15} />
      </ToolBtn>
      {editor.isActive('codeBlock') && (
        <select
          className="md-lang"
          title="代码语言"
          disabled={disabled}
          value={editor.getAttributes('codeBlock').language || ''}
          onMouseDown={(e) => e.preventDefault()}
          onChange={(e) => {
            const language = e.target.value || null
            editor.chain().focus().updateAttributes('codeBlock', { language }).run()
          }}
        >
          {CODE_LANGS.map((l) => (
            <option key={l.value || 'auto'} value={l.value}>{l.label}</option>
          ))}
        </select>
      )}
      <Sep />
      <ToolBtn title="链接" active={editor.isActive('link')} disabled={disabled} onClick={setLink}>
        <Link2 size={15} />
      </ToolBtn>
      <ToolBtn title="图片链接" disabled={disabled} onClick={insertImageUrl}>
        <ImagePlus size={15} />
      </ToolBtn>
      <ToolBtn title="上传图片" disabled={disabled} onClick={() => fileRef.current?.click()}>
        <Upload size={15} />
      </ToolBtn>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onPickImage(e.target.files)} />
      <ToolBtn title="插入表格" disabled={disabled} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
        <Table2 size={15} />
      </ToolBtn>
      <ToolBtn title="分割线" disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <Minus size={15} />
      </ToolBtn>
      {editor.isActive('table') && (
        <>
          <Sep />
          <button type="button" className="md-tool-text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>加列</button>
          <button type="button" className="md-tool-text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>加行</button>
          <button type="button" className="md-tool-text danger" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}>删表</button>
        </>
      )}
      </div>

      <PromptDialog
        open={prompt?.type === 'link'}
        title="插入链接"
        label="链接地址"
        defaultValue={prompt?.type === 'link' ? prompt.value : 'https://'}
        placeholder="https://"
        confirmText="插入"
        onClose={() => setPrompt(null)}
        onConfirm={(url) => {
          if (!url.trim()) {
            editor.chain().focus().extendMarkRange('link').unsetLink().run()
            return
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run()
        }}
      />
      <PromptDialog
        open={prompt?.type === 'image'}
        title="插入图片"
        label="图片地址"
        defaultValue={prompt?.type === 'image' ? prompt.value : 'https://'}
        placeholder="https://"
        confirmText="插入"
        onClose={() => setPrompt(null)}
        onConfirm={(url) => {
          if (!url.trim()) return
          editor.chain().focus().setImage({ src: url.trim() }).run()
        }}
      />
      <ConfirmDialog
        open={!!alertMsg}
        title="无法上传"
        message={alertMsg}
        confirmText="知道了"
        onClose={() => setAlertMsg('')}
        onConfirm={() => setAlertMsg('')}
      />
    </>
  )
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { workspaceId, node, mode, onSaveState, onOutlineChange },
  ref,
) {
  const [sourceMode, setSourceMode] = useState(false)
  const [source, setSource] = useState('')
  const versionRef = useRef(node.version)
  const [loaded, setLoaded] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  const previewRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  const outline = useMemo(() => extractOutline(source), [source])

  useEffect(() => {
    onOutlineChange?.(outline)
  }, [outline, onOutlineChange])

  const save = useCallback(async (content: string) => {
    try {
      onSaveState('保存中…')
      const n = await api.putContent(workspaceId, node.id, content, versionRef.current)
      versionRef.current = n.version
      setSource(content)
      onSaveState('已保存')
    } catch (e) {
      onSaveState(e instanceof Error ? e.message : '保存失败')
    }
  }, [workspaceId, node.id, onSaveState])

  const scheduleSave = useCallback((content: string) => {
    onSaveState('编辑中…')
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { void save(content) }, 1200)
  }, [onSaveState, save])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: null,
        languageClassPrefix: 'language-',
      }),
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: '开始书写笔记… 支持标题、列表、代码、表格、任务清单' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({
        table: { resizable: false },
      }),
    ],
    content: '',
    onUpdate: ({ editor: ed }) => {
      const md = htmlToMd(ed.getHTML())
      setSource(md)
      scheduleSave(md)
    },
  }, [node.id, scheduleSave])

  const jumpToHeading = useCallback((index: number) => {
    const item = extractOutline(source)[index]
    if (!item) return

    if (mode === 'view') {
      const el = previewRef.current?.querySelector(`#toc-${index}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    if (sourceMode) {
      // 源码模式：跳到对应行
      const lines = source.split('\n')
      let count = -1
      let lineIdx = 0
      for (let i = 0; i < lines.length; i++) {
        if (/^#{1,3}\s+/.test(lines[i])) {
          count += 1
          if (count === index) {
            lineIdx = i
            break
          }
        }
      }
      const ta = surfaceRef.current?.querySelector('textarea.source') as HTMLTextAreaElement | null
      if (ta) {
        const before = lines.slice(0, lineIdx).join('\n')
        const pos = before.length + (lineIdx > 0 ? 1 : 0)
        ta.focus()
        ta.setSelectionRange(pos, pos + lines[lineIdx].length)
        const ratio = lineIdx / Math.max(lines.length, 1)
        ta.scrollTop = ratio * ta.scrollHeight
      }
      return
    }

    if (!editor) return
    let seen = -1
    let targetPos: number | null = null
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name !== 'heading') return true
      seen += 1
      if (seen === index) {
        targetPos = pos
        return false
      }
      return true
    })
    if (targetPos == null) return
    const dom = editor.view.nodeDOM(targetPos)
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ behavior: 'smooth', block: 'center' })
      editor.chain().focus().setTextSelection(targetPos + 1).run()
    }
  }, [source, mode, sourceMode, editor])

  useImperativeHandle(ref, () => ({
    jumpToHeading,
    getOutline: () => extractOutline(source),
  }), [jumpToHeading, source])

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    api.getContent(workspaceId, node.id).then((res) => {
      if (cancelled) return
      versionRef.current = res.version
      setSource(res.content)
      editor?.commands.setContent(mdToHtml(res.content), { emitUpdate: false })
      setLoaded(true)
      onSaveState('已加载')
    }).catch((e) => onSaveState(e.message))
    return () => {
      cancelled = true
      window.clearTimeout(timerRef.current)
    }
  }, [workspaceId, node.id, editor, onSaveState])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const content = sourceMode ? source : htmlToMd(editor?.getHTML() || '')
        void save(content)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sourceMode, source, editor, save])

  if (!loaded) return <div className="panel-card muted">加载笔记…</div>

  if (mode === 'view') {
    return (
      <div
        ref={previewRef}
        className="panel-card md-editor md-preview"
        dangerouslySetInnerHTML={{ __html: mdToHtmlWithIds(source) }}
      />
    )
  }

  return (
    <div className="panel-card md-editor" ref={surfaceRef}>
      <div className="md-toolbar-wrap">
        <div className="mode-tabs">
          <button
            type="button"
            className={`btn ${!sourceMode ? 'primary' : ''}`}
            onClick={() => {
              if (sourceMode) editor?.commands.setContent(mdToHtml(source), { emitUpdate: false })
              setSourceMode(false)
            }}
          >所见即所得</button>
          <button
            type="button"
            className={`btn ${sourceMode ? 'primary' : ''}`}
            onClick={() => {
              const md = htmlToMd(editor?.getHTML() || '')
              setSource(md)
              setSourceMode(true)
            }}
          >源码</button>
        </div>
        {editor && <Toolbar editor={editor} disabled={sourceMode} />}
      </div>
      {sourceMode ? (
        <textarea
          className="source"
          value={source}
          spellCheck={false}
          onChange={(e) => {
            setSource(e.target.value)
            scheduleSave(e.target.value)
          }}
        />
      ) : (
        <EditorContent editor={editor} className="md-surface" />
      )}
    </div>
  )
})

export function OutlineMenu({
  items,
  open,
  onToggle,
  onJump,
}: {
  items: OutlineItem[]
  open: boolean
  onToggle: () => void
  onJump: (index: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onToggle()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onToggle()
    }
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', onDoc)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onToggle])

  return (
    <div className="toc-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn soft toc-btn ${open ? 'active' : ''}`}
        onClick={onToggle}
        title="目录导航"
      >
        <ListTree size={15} /> 目录
        {items.length > 0 ? <span className="toc-count">{items.length}</span> : null}
      </button>
      {open && (
        <div className="toc-panel" role="menu">
          <div className="toc-panel-title">本文目录</div>
          {items.length === 0 ? (
            <div className="toc-empty">暂无标题，用 H1–H3 写几个章节吧</div>
          ) : (
            <ul className="toc-list">
              {items.map((it, idx) => (
                <li key={it.id} className={`toc-item level-${it.level}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onJump(idx)
                      if (open) onToggle()
                    }}
                  >
                    {it.text}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
