import { createMarkdownTokenizerStart } from './markdown-tokenizer-start'
import {
  getRenderedAttributes,
  mergeAttributes,
  type AnyExtension,
  type Editor
} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { RichMarkdownTrailingParagraph } from './rich-markdown-trailing-paragraph'
import { RichMarkdownLink } from './rich-markdown-link-mark'
import { Code } from '@tiptap/extension-code'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { RichMarkdownTaskItem } from './rich-markdown-task-item'
import { RichMarkdownTable } from './rich-markdown-table'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { createRichMarkdownExtension } from './rich-markdown-extension'
import { RichMarkdownClipboardLinkOrigin } from './rich-markdown-clipboard-link-origin'
import { createLowlight, common } from 'lowlight'
import {
  acquireLocalImageSrcLease,
  loadLocalImageSrc,
  onImageCacheInvalidated
} from './useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  createRawMarkdownHtmlBlock,
  createRawMarkdownHtmlInline,
  createRichMarkdownLiteral
} from './raw-markdown-html-nodes'
import {
  createOrcaDetailsExtensions,
  getRichMarkdownPlaceholder
} from './rich-markdown-details-extension'
import { createMarkdownDocLink } from './rich-markdown-doc-link'
import { RichMarkdownCodeBlock } from './RichMarkdownCodeBlock'
import { ReactNodeViewRenderer } from '@tiptap/react'
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
import { documentResourceAccess } from '@/lib/local-file-access'
import {
  readRichMarkdownImageRuntimeContext,
  resolveRichMarkdownImageUrl
} from './rich-markdown-image-context'

const lowlight = createCachedLowlight(createLowlight(common))

const RichMarkdownCode = Code.extend({
  // Permit linked code labels while keeping emphasis marks excluded.
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
    // Eligibility and live editing must share extensions or a document deemed safe could still lose syntax on save.
    StarterKit.configure({
      link: false,
      code: false,
      codeBlock: false,
      orderedList: false,
      paragraph: false,
      trailingNode: false
    }),
    RichMarkdownParagraph,
    RichMarkdownTrailingParagraph,
    RichMarkdownCode,
    RichMarkdownCodeBlockLowlight.extend({
      addNodeView() {
        // This component never reads getPos; earlier typing must not rerender it merely by shifting its position.
        return ReactNodeViewRenderer(RichMarkdownCodeBlock, {
          update: positionStableNodeViewUpdate
        })
      }
    }).configure({
      lowlight,
      defaultLanguage: null
    }),
    RichMarkdownLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true
    }),
    RichMarkdownClipboardLinkOrigin,
    // Load local images through IPC/blob URLs so dev-server cross-origin restrictions cannot block file URLs.
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
        // The extensionManager.attributes getter recomputes across all extensions; resolve it once per editor.
        let imageAttributes: Editor['extensionManager']['attributes'] | undefined
        return ({ node, HTMLAttributes, editor }) => {
          // A wrapper prevents native image-byte dragging from conflicting with ProseMirror’s schema-node relocation.
          const dom = document.createElement('span')
          // Keep the image wrapper inline so it cannot break surrounding text onto separate lines.
          dom.style.display = 'inline-block'
          dom.style.lineHeight = '0'
          dom.style.maxWidth = '100%'

          const img = document.createElement('img')
          img.draggable = false
          let renderedAttributeNames = new Set<string>()
          const syncImageAttributes = (attributes: Record<string, unknown>): void => {
            const nextNames = new Set<string>()
            for (const [key, value] of Object.entries(attributes)) {
              if (key === 'src' || key === 'draggable' || value == null || value === false) {
                continue
              }
              nextNames.add(key)
              const renderedValue = String(value)
              if (img.getAttribute(key) !== renderedValue) {
                img.setAttribute(key, renderedValue)
              }
            }
            for (const key of renderedAttributeNames) {
              if (!nextNames.has(key)) {
                img.removeAttribute(key)
              }
            }
            renderedAttributeNames = nextNames
          }
          syncImageAttributes(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))
          dom.appendChild(img)

          let currentSrc = node.attrs.src as string | undefined
          let currentContextVersion = getImageContextVersion(this.storage)
          let releaseImageLease: (() => void) | undefined

          const loadImage = (src: string | undefined): void => {
            releaseImageLease?.()
            releaseImageLease = undefined
            const fp = this.storage.filePath as string
            const runtimeContext = readRichMarkdownImageRuntimeContext(this.storage)
            const contextVersionAtLoad = getImageContextVersion(this.storage)
            if (src && fp) {
              const access = documentResourceAccess(fp)
              releaseImageLease = acquireLocalImageSrcLease(
                src,
                fp,
                undefined,
                runtimeContext,
                access
              )
              void loadLocalImageSrc(src, fp, undefined, runtimeContext, access).then(
                (resolved) => {
                  if (currentSrc !== src || currentContextVersion !== contextVersionAtLoad) {
                    return
                  }
                  if (resolved) {
                    img.src = resolved
                    return
                  }
                  // Local paths require main’s file checks; failed loads must not fall back to Chromium reading raw paths.
                  img.removeAttribute('src')
                }
              )
            } else if (src) {
              img.src = resolveRichMarkdownImageUrl(this.storage, src)
            } else {
              img.removeAttribute('src')
            }
          }

          loadImage(currentSrc)

          // Cache invalidation on refocus must reload replaced/deleted image files from disk.
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
              syncImageAttributes(
                mergeAttributes(
                  this.options.HTMLAttributes,
                  getRenderedAttributes(
                    updatedNode,
                    (imageAttributes ??= editor.extensionManager.attributes.filter(
                      (attribute) => attribute.type === 'image'
                    ))
                  )
                )
              )
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
      // Markdown nests images in paragraphs; block image nodes would become schema-invalid and crash on the first edit.
      inline: true
    }),
    RichMarkdownOrderedList,
    RichMarkdownTaskList,
    RichMarkdownTaskItem.configure({
      nested: true
    }),
    ...createOrcaDetailsExtensions(),
    RichMarkdownTable.configure({
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
    BlockMath.extend({
      markdownTokenizer:
        BlockMath.config.markdownTokenizer &&
        typeof BlockMath.config.markdownTokenizer !== 'function'
          ? {
              ...BlockMath.config.markdownTokenizer,
              start: createMarkdownTokenizerStart('$$')
            }
          : BlockMath.config.markdownTokenizer
    }).configure({
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
