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

function findDocumentSubtree(root: ParentNode): Element | null {
  return root.querySelector(DOCUMENT_SUBTREE_SELECTOR)
}

/**
 * Extract a clean, self-contained HTML export payload from a panel-scoped
 * markdown surface. Returns null when the requested file is stale or the
 * surface is in a mode (Monaco source) that does not render a document DOM.
 */
export async function getActiveMarkdownExportPayload({
  fileId,
  root
}: {
  fileId: string
  root: ParentNode | null
}): Promise<MarkdownExportPayload | null> {
  if (!root) {
    return null
  }
  const state = useAppStore.getState()
  const activeFile = state.openFiles.find((f) => f.id === fileId)
  if (!activeFile || (activeFile.mode !== 'edit' && activeFile.mode !== 'markdown-preview')) {
    return null
  }
  const language = detectLanguage(activeFile.filePath)
  if (language !== 'markdown') {
    return null
  }

  const subtree = findDocumentSubtree(root)
  if (!subtree) {
    return null
  }

  const clone = subtree.cloneNode(true) as Element
  for (const selector of UI_ONLY_SELECTORS) {
    for (const node of clone.querySelectorAll(selector)) {
      node.remove()
    }
  }
  // Why: local-image previews use renderer-scoped blob URLs; the hidden PDF
  // window cannot dereference them, so embed the bytes before export.
  await inlineBlobImageSources(clone)

  const renderedHtml = clone.innerHTML.trim()
  if (!renderedHtml) {
    return null
  }

  const title = basenameWithoutExt(activeFile.relativePath || activeFile.filePath)
  const html = buildMarkdownExportHtml({ title, renderedHtml })
  return { title, html }
}

async function inlineBlobImageSources(root: Element): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'))
  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute('src')
      if (!src) {
        return
      }
      image.setAttribute('src', await readBlobImageAsDataUrl(src))
    })
  )
}

async function readBlobImageAsDataUrl(src: string): Promise<string> {
  try {
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error('Unable to fetch blob image')
    }
    const blob = await response.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to inline image for PDF export: ${message}`)
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
