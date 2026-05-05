import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { buildMarkdownExportHtml } from './markdown-export-html'

export type MarkdownExportPayload = {
  title: string
  html: string
}

// Why: the export subtree is the smallest DOM that represents the rendered
// document. Preview mode uses `.markdown-body` (the .markdown-preview wrapper
// also contains the search bar chrome), and rich mode uses `.ProseMirror`
// (the surrounding .rich-markdown-editor-shell contains the toolbar, search
// bar, link bubble, and slash menu as siblings).
const DOCUMENT_SUBTREE_SELECTOR = '.ProseMirror, .markdown-body'

// Why: even after picking the smallest subtree, a few in-document UI leaks
// can remain. The design doc lists these by name and treats the cloned-scrub
// pass as a belt-and-suspenders defense so PDF output never shows copy
// buttons, per-block search highlights, or other transient affordances.
const UI_ONLY_SELECTORS = [
  '.code-block-copy-btn',
  '.markdown-preview-search',
  '[class*="rich-markdown-search"]',
  '[data-orca-export-hide="true"]'
]

function basenameWithoutExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * Locate the active markdown document DOM subtree. v1 uses a scoped query
 * over the whole document: there is only one active markdown surface at a
 * time, and both preview and rich modes paint a uniquely-classed container.
 * If multi-pane split view ever makes multiple surfaces visible at once,
 * this contract must be revisited (see design doc §4).
 */
function findActiveDocumentSubtree(): Element | null {
  return document.querySelector(DOCUMENT_SUBTREE_SELECTOR)
}

/**
 * Extract a clean, self-contained HTML export payload from the active
 * markdown surface. Returns null when no markdown document is active or the
 * surface is in a mode (Monaco source) that does not render a document DOM.
 */
export function getActiveMarkdownExportPayload(): MarkdownExportPayload | null {
  const state = useAppStore.getState()
  if (state.activeTabType !== 'editor') {
    return null
  }
  const activeFile = state.openFiles.find((f) => f.id === state.activeFileId)
  if (!activeFile || activeFile.mode !== 'edit') {
    return null
  }
  const language = detectLanguage(activeFile.filePath)
  if (language !== 'markdown') {
    return null
  }

  const subtree = findActiveDocumentSubtree()
  if (!subtree) {
    return null
  }

  const clone = subtree.cloneNode(true) as Element
  for (const selector of UI_ONLY_SELECTORS) {
    for (const node of clone.querySelectorAll(selector)) {
      node.remove()
    }
  }

  const renderedHtml = clone.innerHTML.trim()
  if (!renderedHtml) {
    return null
  }

  const title = basenameWithoutExt(activeFile.relativePath || activeFile.filePath)
  const html = buildMarkdownExportHtml({ title, renderedHtml })
  return { title, html }
}
