import { Extension, type Editor } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  readRichMarkdownImageRuntimeContext,
  type RichMarkdownImageRuntimeContext
} from './rich-markdown-image-context'
import {
  isRelativeClipboardLink,
  rebaseClipboardLink,
  resolveRelativeClipboardLink
} from './rich-markdown-clipboard-link-target'

const LINK_ORIGIN_ATTRIBUTE = 'data-orca-link-clipboard-origin'
const MAX_ORIGINS = 16
const MAX_LINKS_PER_ORIGIN = 256

type ClipboardDocument = {
  filePath: string
  workspaceRoot: string
  runtimeContext: RichMarkdownImageRuntimeContext
}
type ClipboardOrigin = ClipboardDocument & { links: Map<string, string> }

// Why: absolute source paths stay in this renderer; the clipboard only carries an opaque id.
const origins = new Map<string, ClipboardOrigin>()

function readClipboardDocument(editor: Editor): ClipboardDocument | null {
  const storage: unknown = 'image' in editor.storage ? editor.storage.image : undefined
  if (
    !storage ||
    typeof storage !== 'object' ||
    !('filePath' in storage) ||
    typeof storage.filePath !== 'string' ||
    !storage.filePath
  ) {
    return null
  }
  const runtimeContext = readRichMarkdownImageRuntimeContext({
    runtimeContext: 'runtimeContext' in storage ? storage.runtimeContext : undefined
  })
  const workspaceRoot = runtimeContext?.worktreePath
  return runtimeContext && runtimeContext.worktreeId && workspaceRoot
    ? { filePath: storage.filePath, workspaceRoot, runtimeContext }
    : null
}

function sameWorkspace(
  source: RichMarkdownImageRuntimeContext,
  destination: RichMarkdownImageRuntimeContext
): boolean {
  return (
    source.worktreeId === destination.worktreeId &&
    source.worktreePath === destination.worktreePath &&
    source.target.kind === destination.target.kind &&
    (source.target.kind !== 'environment' ||
      (destination.target.kind === 'environment' &&
        source.target.environmentId === destination.target.environmentId)) &&
    (source.connectionId ?? null) === (destination.connectionId ?? null) &&
    source.expectedExternalSshTargetId === destination.expectedExternalSshTargetId
  )
}

function rebaseClipboardLinks(html: string, editor: Editor): string {
  if (!html.includes(LINK_ORIGIN_ATTRIBUTE)) {
    return html
  }
  const destination = readClipboardDocument(editor)
  if (!destination) {
    return html
  }
  const document = new DOMParser().parseFromString(html, 'text/html')
  let changed = false
  for (const link of document.querySelectorAll(`a[${LINK_ORIGIN_ATTRIBUTE}]`)) {
    const origin = origins.get(link.getAttribute(LINK_ORIGIN_ATTRIBUTE) ?? '')
    const href = link.getAttribute('href')
    const absoluteHref = href ? origin?.links.get(href) : undefined
    if (
      !origin ||
      !href ||
      !absoluteHref ||
      !sameWorkspace(origin.runtimeContext, destination.runtimeContext)
    ) {
      continue
    }
    const rebased = rebaseClipboardLink(
      href,
      absoluteHref,
      destination.filePath,
      destination.workspaceRoot
    )
    if (rebased !== href) {
      link.setAttribute('href', rebased)
      changed = true
    }
  }
  return changed ? document.body.innerHTML : html
}

export const RichMarkdownClipboardLinkOrigin = Extension.create({
  name: 'richMarkdownClipboardLinkOrigin',
  addProseMirrorPlugins() {
    const editor = this.editor
    const serializer = DOMSerializer.fromSchema(editor.schema)
    const serializeLink = serializer.marks.link
    if (!serializeLink) {
      return []
    }
    let originId: string | null = null
    let source: ClipboardDocument | null | undefined
    const captureOrigin = (href: string): string | null => {
      if (source === undefined) {
        source = readClipboardDocument(editor)
      }
      const absoluteHref = source ? resolveRelativeClipboardLink(href, source.filePath) : null
      if (!source || !absoluteHref) {
        return null
      }
      let origin = originId ? origins.get(originId) : undefined
      if (!origin) {
        originId = createBrowserUuid()
        origin = { ...source, links: new Map() }
        origins.set(originId, origin)
        if (origins.size > MAX_ORIGINS) {
          const oldest = origins.keys().next().value
          if (oldest !== undefined) {
            origins.delete(oldest)
          }
        }
      }
      if (!origin.links.has(href)) {
        if (origin.links.size >= MAX_LINKS_PER_ORIGIN) {
          return null
        }
        origin.links.set(href, absoluteHref)
      }
      return originId
    }
    return [
      new Plugin({
        props: {
          transformPastedHTML: (html) => rebaseClipboardLinks(html, editor),
          // Why: ProseMirror calls transformCopied before serializing, so each copy gets a fresh origin.
          transformCopied: (slice) => {
            originId = null
            source = undefined
            return slice
          },
          clipboardSerializer: new DOMSerializer(serializer.nodes, {
            ...serializer.marks,
            link: (mark, inline) => {
              const result = DOMSerializer.renderSpec(document, serializeLink(mark, inline))
              const href: unknown = mark.attrs.href
              if (
                typeof href === 'string' &&
                isRelativeClipboardLink(href) &&
                result.dom instanceof HTMLElement
              ) {
                const id = captureOrigin(href)
                if (id) {
                  result.dom.setAttribute(LINK_ORIGIN_ATTRIBUTE, id)
                }
              }
              return result
            }
          })
        }
      })
    ]
  }
})
