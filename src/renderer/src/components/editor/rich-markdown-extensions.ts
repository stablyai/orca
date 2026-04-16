import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { Markdown } from '@tiptap/markdown'
import { createLowlight, common } from 'lowlight'
import { loadLocalImageSrc, onImageCacheInvalidated } from './useLocalImageSrc'
import { RawMarkdownHtmlBlock, RawMarkdownHtmlInline } from './raw-markdown-html'
import { RichMarkdownCodeBlock } from './RichMarkdownCodeBlock'
import { safeReactNodeViewRenderer } from './safe-react-node-view-renderer'
import { DragSelectionGuard } from './drag-selection-guard'

const lowlight = createLowlight(common)

const RICH_MARKDOWN_PLACEHOLDER = 'Write markdown… Type / for blocks.'

export function createRichMarkdownExtensions({
  includePlaceholder = false
}: {
  includePlaceholder?: boolean
} = {}): AnyExtension[] {
  const extensions: AnyExtension[] = [
    // Why: rich-mode detection must use the exact same markdown extension set as
    // the live editor. If these drift, Orca can claim a document is editable in
    // preview and then still lose syntax on save.
    StarterKit.configure({
      link: false,
      codeBlock: false
    }),
    CodeBlockLowlight.extend({
      addNodeView() {
        return safeReactNodeViewRenderer(RichMarkdownCodeBlock)
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
        return { filePath: '' }
      },
      addNodeView() {
        return ({ node, HTMLAttributes }) => {
          // Why: wrapping the <img> in a container prevents the browser's
          // native image drag (which sends image bytes) from conflicting with
          // ProseMirror's node-level drag (which serializes the schema node
          // for relocation within the document).
          const dom = document.createElement('div')
          dom.style.lineHeight = '0'

          const img = document.createElement('img')
          img.draggable = false
          for (const [key, value] of Object.entries(HTMLAttributes)) {
            if (key !== 'src' && value != null && value !== false) {
              img.setAttribute(key, String(value))
            }
          }
          dom.appendChild(img)

          let currentSrc = node.attrs.src as string | undefined

          const loadImage = (src: string | undefined): void => {
            const fp = this.storage.filePath as string
            if (src && fp) {
              // Why: when IPC resolution fails (e.g. unsupported format),
              // the ternary falls back to the raw src so the browser can
              // attempt its own loading rather than leaving a broken image.
              void loadLocalImageSrc(src, fp).then((resolved) => {
                img.src = resolved ? resolved : src
              })
            } else if (src) {
              img.src = src
            }
          }

          loadImage(currentSrc)

          // Why: when the user refocuses the window after deleting or replacing
          // image files, the blob URL cache is cleared and this callback re-loads
          // the image from disk so the editor reflects the current filesystem state.
          const unsubscribe = onImageCacheInvalidated(() => {
            loadImage(currentSrc)
          })

          return {
            dom,
            update: (updatedNode) => {
              if (updatedNode.type.name !== 'image') {
                return false
              }
              const newSrc = updatedNode.attrs.src as string | undefined
              if (newSrc !== currentSrc) {
                currentSrc = newSrc
                loadImage(newSrc)
              }
              return true
            },
            destroy: () => {
              unsubscribe()
            }
          }
        }
      }
    }).configure({
      allowBase64: true
    }),
    TaskList,
    TaskItem.configure({
      nested: true
    }),
    Table.configure({
      resizable: false
    }),
    TableRow,
    TableHeader,
    TableCell,
    RawMarkdownHtmlInline,
    RawMarkdownHtmlBlock,
    DragSelectionGuard,
    Markdown.configure({
      markedOptions: {
        gfm: true
      }
    })
  ]

  if (includePlaceholder) {
    extensions.push(
      Placeholder.configure({
        placeholder: RICH_MARKDOWN_PLACEHOLDER
      })
    )
  }

  return extensions
}
