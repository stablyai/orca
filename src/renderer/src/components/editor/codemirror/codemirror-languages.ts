import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { java } from '@codemirror/lang-java'

export const LARGE_FILE_HIGHLIGHT_LIMIT = 500_000

export function resolveCodeMirrorLanguage(
  language: string,
  filePath: string,
  contentLength?: number
): Extension {
  if (contentLength !== undefined && contentLength > LARGE_FILE_HIGHLIGHT_LIMIT) {
    return []
  }

  const normalized = language.trim().toLowerCase()
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const key = normalized || ext

  if (key === 'typescript' || key === 'ts' || ext === 'ts' || ext === 'mts' || ext === 'cts') {
    return javascript({ typescript: true, jsx: false })
  }
  if (key === 'typescriptreact' || key === 'tsx' || ext === 'tsx') {
    return javascript({ typescript: true, jsx: true })
  }
  if (key === 'javascriptreact' || key === 'jsx' || ext === 'jsx') {
    return javascript({ typescript: false, jsx: true })
  }
  if (key === 'javascript' || key === 'js' || ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return javascript({ typescript: false, jsx: false })
  }
  if (key === 'python' || key === 'py' || ext === 'py' || ext === 'pyi' || ext === 'pyw') {
    return python()
  }
  if (key === 'rust' || key === 'rs' || ext === 'rs') {
    return rust()
  }
  if (key === 'json' || key === 'jsonc' || ext === 'json' || ext === 'jsonc' || ext === 'json5') {
    return json()
  }
  if (
    key === 'html' ||
    key === 'htm' ||
    key === 'xml' ||
    ext === 'html' ||
    ext === 'htm' ||
    ext === 'xml' ||
    ext === 'svg'
  ) {
    return html()
  }
  if (
    key === 'css' ||
    key === 'scss' ||
    key === 'less' ||
    ext === 'css' ||
    ext === 'scss' ||
    ext === 'less'
  ) {
    return css()
  }
  if (key === 'markdown' || key === 'md' || ext === 'md' || ext === 'mdx' || ext === 'markdown') {
    return markdown()
  }
  if (key === 'yaml' || key === 'yml' || ext === 'yml' || ext === 'yaml') {
    return yaml()
  }
  if (key === 'java' || ext === 'java') {
    return java()
  }
  return []
}
