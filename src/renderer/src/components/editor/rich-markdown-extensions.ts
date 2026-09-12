import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { Code } from '@tiptap/extension-code'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { createRichMarkdownExtension } from './rich-markdown-extension'
import { createLowlight, common } from 'lowlight'
import {
  acquireLocalImageSrcLease,
  loadLocalImageSrc,
  onImageCacheInvalidated
} from './useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  createRawMarkdownHtmlBlock,
  createRawMarkdownHtmlInline,
  createRichMarkdownLiteral
} from './raw-markdown-html'
import {
  createOrcaDetailsExtensions,
  getRichMarkdownPlaceholder
} from './rich-markdown-details-extension'
import { createMarkdownDocLink } from './rich-markdown-doc-link'
import { RichMarkdownCodeBlock } from './RichMarkdownCodeBlock'
import { safeReactNodeViewRenderer } from './safe-react-node-view-renderer'
import { positionStableNodeViewUpdate } from './position-stable-node-view-update'
import { DragSelectionGuard } from './drag-selection-guard'
import { createRichMarkdownAnnotationHighlightExtension } from './rich-markdown-annotation-highlight'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLink } from './rich-markdown-html-superscript-link'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { RichMarkdownOrderedList } from './rich-markdown-ordered-list'
import { RichMarkdownParagraph } from './rich-markdown-paragraph'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'
import { RichMarkdownTaskList } from './rich-markdown-task-list'
import { createCachedLowlight } from './rich-markdown-lowlight-cache'

const lowlight = createCachedLowlight(createLowlight(common))

const RichMarkdownCode = Code.extend({
  // Why: Markdown supports linked code labels, so code cannot exclude the link
  // mark even though it should still stay exclusive with emphasis marks.
  excludes: 'code bold italic strike underline'
})

export function createRichMarkdownExtensions({
  codec,
  includePlaceholder = false,
  htmlSuperscriptLinks = false,
  htmlSuperscriptLinkContext
}: {
  codec: RichMarkdownEditorCodec
  includePlaceholder?: boolean
  htmlSuperscriptLinks?: boolean
  htmlSuperscriptLinkContext?: RichMarkdownHtmlSuperscriptLinkContext
}): AnyExtension[] {
  if (htmlSuperscriptLinks && !htmlSuperscriptLinkContext) {
    throw new Error('HTML superscript links require a document interaction context')
  }
  const extensions: AnyExtension[] = [
    // Why: rich-mode detection must use the exact same markdown extension set as
    // the live editor. If these drift, Orca can claim a document is editable in
    // preview and then still lose syntax on save.
    StarterKit.configure({
      link: false,
      code: false,
      codeBlock: false,
      orderedList: false,
      paragraph: false
    }),
    RichMarkdownParagraph,
    RichMarkdownCode,
    RichMarkdownCodeBlockLowlight.extend({
      addNodeView() {
        // Why: RichMarkdownCodeBlock never reads getPos, so it must not re-render
        // just because earlier edits shifted this block's document position.
        return safeReactNodeViewRenderer(RichMarkdownCodeBlock, {
          update: positionStableNodeViewUpdate
        })
      }
    }).configure({
      lowlight,
      defaultLanguage: null
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true
    }),
    // Why: in dev mode the renderer is served from http://localhost, so
    // file:// URLs in <img> tags are blocked by cross-origin restrictions.
    // A nodeView loads local images via IPC → blob URL, which bypasses this
    // and works identically in dev and production modes.
    Image.extend({
      addStorage() {
        return {
          contextVersion: 0,
          filePath: '',
          reloadListeners: new Set<() => void>(),
          runtimeContext: undefined as RuntimeFileOperationArgs | undefined
        }
      },
      addNodeView() {
        return ({ node, HTMLAttributes }) => {
          // Why: wrapping the <img> in a container prevents the browser's
          // native image drag (which sends image bytes) from conflicting with
          // ProseMirror's node-level drag (which serializes the schema node
          // for relocation within the document).
          const dom = document.createElement('span')
          // Why: the wrapper sits in inline content, so it must not introduce a
          // block box or the surrounding text would break onto its own line.
          dom.style.display = 'inline-block'
          dom.style.lineHeight = '0'
          dom.style.maxWidth = '100%'

          const img = document.createElement('img')
          img.draggable = false
          for (const [key, value] of Object.entries(HTMLAttributes)) {
            if (key !== 'src' && value != null && value !== false) {
              img.setAttribute(key, String(value))
            }
          }
          dom.appendChild(img)

          let currentSrc = node.attrs.src as string | undefined
          let currentContextVersion = getImageContextVersion(this.storage)
          let releaseImageLease: (() => void) | undefined

          const loadImage = (src: string | undefined): void => {
            releaseImageLease?.()
            releaseImageLease = undefined
            const fp = this.storage.filePath as string
            const runtimeContext = this.storage.runtimeContext as
              | RuntimeFileOperationArgs
              | undefined
            const contextVersionAtLoad = getImageContextVersion(this.storage)
            if (src && fp) {
              releaseImageLease = acquireLocalImageSrcLease(src, fp, undefined, runtimeContext)
              void loadLocalImageSrc(src, fp, undefined, runtimeContext).then((resolved) => {
                if (currentSrc !== src || currentContextVersion !== contextVersionAtLoad) {
                  return
                }
                if (resolved) {
                  img.src = resolved
                  return
                }
                // Why: local image paths must stay behind IPC/runtime
                // authorization; a failed load should render missing, not
                // hand the raw path back to Chromium.
                img.removeAttribute('src')
              })
            } else if (src) {
              img.src = src
            } else {
              img.removeAttribute('src')
            }
          }

          loadImage(currentSrc)

          // Why: when the user refocuses the window after deleting or replacing
          // image files, the blob URL cache is cleared and this callback re-loads
          // the image from disk so the editor reflects the current filesystem state.
          const unsubscribe = onImageCacheInvalidated(() => {
            loadImage(currentSrc)
          })
          const reloadForContextChange = (): void => {
            currentContextVersion = getImageContextVersion(this.storage)
            loadImage(currentSrc)
          }
          const reloadListeners = this.storage.reloadListeners
          if (reloadListeners instanceof Set) {
            reloadListeners.add(reloadForContextChange)
          }

          return {
            dom,
            update: (updatedNode) => {
              if (updatedNode.type.name !== 'image') {
                return false
              }
              const newSrc = updatedNode.attrs.src as string | undefined
              const nextContextVersion = getImageContextVersion(this.storage)
              if (newSrc !== currentSrc || nextContextVersion !== currentContextVersion) {
                currentSrc = newSrc
                currentContextVersion = nextContextVersion
                loadImage(newSrc)
              }
              return true
            },
            destroy: () => {
              releaseImageLease?.()
              if (reloadListeners instanceof Set) {
                reloadListeners.delete(reloadForContextChange)
              }
              unsubscribe()
            }
          }
        }
      }
    }).configure({
      allowBase64: true,
      // Why: the markdown parser nests images inside paragraphs, so a block image
      // node yields a schema-invalid document that only throws on the first edit
      // that reassembles the paragraph.
      inline: true
    }),
    RichMarkdownOrderedList,
    RichMarkdownTaskList,
    TaskItem.configure({
      nested: true
    }),
    ...createOrcaDetailsExtensions(),
    Table.configure({
      resizable: false
    }),
    TableRow,
    TableHeader,
    TableCell,
    InlineMath.configure({
      katexOptions: {
        throwOnError: false
      }
    }),
    BlockMath.configure({
      katexOptions: {
        displayMode: true,
        throwOnError: false
      }
    }),
    createRichMarkdownLiteral(codec.transport),
    ...(htmlSuperscriptLinks
      ? [createRichMarkdownHtmlSuperscriptLink(codec.transport, htmlSuperscriptLinkContext!)]
      : []),
    createRawMarkdownHtmlInline(codec.transport),
    createRawMarkdownHtmlBlock(codec.transport),
    createMarkdownDocLink(codec.transport),
    DragSelectionGuard,
    createRichMarkdownExtension(codec, htmlSuperscriptLinks).configure({
      marked: codec.marked,
      markedOptions: {
        gfm: true
      }
    }),
    createRichMarkdownAnnotationHighlightExtension()
  ]

  if (includePlaceholder) {
    extensions.push(
      Placeholder.configure({
        includeChildren: true,
        placeholder: getRichMarkdownPlaceholder
      })
    )
  }

  return extensions
}

function getImageContextVersion(storage: Record<string, unknown>): number {
  const version = storage.contextVersion
  return typeof version === 'number' ? version : 0
}
