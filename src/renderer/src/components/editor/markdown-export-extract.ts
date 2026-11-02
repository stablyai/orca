import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { buildMarkdownExportHtml } from './markdown-export-html'

export type MarkdownExportPayload = {
  title: string
  html: string
}

// Select only document DOM, excluding preview search and rich-editor toolbars, menus and bubbles.
const DOCUMENT_SUBTREE_SELECTOR = '.ProseMirror, .markdown-body'

// Remove in-document controls and transient highlights from the cloned export subtree.
const UI_ONLY_SELECTORS = [
  '.code-block-copy-btn',
  '.markdown-preview-search',
  '[class*="rich-markdown-search"]',
  // Keep the explicit class fallback if export-hide attributes are stripped.
  '.markdown-annotation-controls',
  '[data-orca-export-hide]'
]

function basenameWithoutExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function findDocumentSubtree(root: ParentNode): Element | null {
  return root.querySelector(DOCUMENT_SUBTREE_SELECTOR)
}

/** Clone the panel’s rendered document without UI; return null for stale files or source-only views. */
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
  if (!subtree || subtree.hasAttribute('data-markdown-preview-incomplete')) {
    return null
  }

  const clone = subtree.cloneNode(true) as Element
  for (const selector of UI_ONLY_SELECTORS) {
    for (const node of clone.querySelectorAll(selector)) {
      node.remove()
    }
  }
  // Inline renderer-owned blob images because the hidden PDF window cannot resolve their URLs.
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
