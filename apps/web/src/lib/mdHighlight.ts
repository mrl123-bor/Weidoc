import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { common, createLowlight } from 'lowlight'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('docker', dockerfile)
hljs.registerLanguage('go', go)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('env', ini)
hljs.registerLanguage('properties', ini)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

export const lowlight = createLowlight(common)
lowlight.register('dockerfile', dockerfile)
lowlight.registerAlias({
  ini: ['env', 'properties'],
  bash: ['shell', 'sh'],
  dockerfile: ['docker'],
  xml: ['html'],
})

export const CODE_LANGS: { value: string; label: string }[] = [
  { value: '', label: '自动 / 纯文本' },
  { value: 'bash', label: 'Bash' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ini', label: 'ENV / INI' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'java', label: 'Java' },
]

export function highlightCode(code: string, lang?: string) {
  const key = (lang || '').trim().toLowerCase()
  if (key && hljs.getLanguage(key)) {
    return hljs.highlight(code, { language: key }).value
  }
  if (!key || key === 'txt' || key === 'text' || key === 'plaintext') {
    return hljs.highlight(code, { language: 'plaintext' }).value
  }
  return hljs.highlightAuto(code).value
}

export function langFromExt(ext: string) {
  switch (ext.toLowerCase()) {
    case 'js': return 'javascript'
    case 'ts': return 'typescript'
    case 'yml': return 'yaml'
    case 'md': case 'markdown': return 'markdown'
    case 'txt': return 'plaintext'
    case 'csv': return 'plaintext'
    case 'env': return 'ini'
    default: return ext.toLowerCase()
  }
}

const markedOpts = { gfm: true, breaks: false } as const

/** 给 TipTap 用的纯 HTML，不含高亮 span，由 CodeBlockLowlight 负责着色 */
export const markedPlain = new Marked(markedOpts)

/** 预览用：带 highlight.js 着色 */
export const markedPretty = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const key = (lang || '').trim().toLowerCase()
      if (key && hljs.getLanguage(key)) {
        return hljs.highlight(code, { language: key }).value
      }
      return hljs.highlightAuto(code).value
    },
  }),
  markedOpts,
)
