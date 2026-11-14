import { createMarkdownTokenizerStart } from '../../markdown/source-scanning/markdown-tokenizer-start'
import {
  getRenderedAttributes,
  mergeAttributes,
  type AnyExtension,
  type Editor
} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { RichMarkdownTrailingParagraph } from './rich-markdown-trailing-paragraph'
import { RichMarkdownLink } from '../links/rich-markdown-link-mark'
import { Code } from '@tiptap/extension-code'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { RichMarkdownTaskItem } from '../lists/rich-markdown-task-item'
import { RichMarkdownTable } from '../tables/rich-markdown-table'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { createRichMarkdownExtension } from './rich-markdown-extension'
import { RichMarkdownClipboardLinkOrigin } from '../clipboard/rich-markdown-clipboard-link-origin'
import { createLowlight, common } from 'lowlight'
import {
  acquireLocalImageSrcLease,
  loadLocalImageSrc
} from '../../document-images/useLocalImageSrc'
import { subscribeToLocalImageCacheInvalidation as onImageCacheInvalidated } from '../../document-images/local-image-src-cache'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import {
  createRawMarkdownHtmlBlock,
  createRawMarkdownHtmlInline,
  createRichMarkdownLiteral
} from '../raw-source/raw-markdown-html-nodes'
import {
  createOrcaDetailsExtensions,
  getRichMarkdownPlaceholder
} from '../details/rich-markdown-details-extension'
import { createMarkdownDocLink } from '../doc-links/rich-markdown-doc-link'
import { RichMarkdownCodeBlock } from '../code-blocks/RichMarkdownCodeBlock'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { positionStableNodeViewUpdate } from './position-stable-node-view-update'
import { DragSelectionGuard } from './drag-selection-guard'
import { createRichMarkdownAnnotationHighlightExtension } from '../review/rich-markdown-annotation-highlight'
import type { RichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLink } from '../citations/rich-markdown-html-superscript-link'
import type { RichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { RichMarkdownOrderedList } from '../lists/rich-markdown-ordered-list'
import { RichMarkdownParagraph } from './rich-markdown-paragraph'
import { RichMarkdownCodeBlockLowlight } from '../code-blocks/rich-markdown-lowlight'
import { RichMarkdownTaskList } from '../lists/rich-markdown-task-list'
import { createCachedLowlight } from '../code-blocks/rich-markdown-lowlight-cache'
import { documentResourceAccess } from '@/lib/files/access/local-file-access'
import { attachRichMarkdownImageErrorLink } from '../images/rich-markdown-image-error-link'
import {
  readRichMarkdownImageRuntimeContext,
  resolveRichMarkdownImageUrl
} from '../images/rich-markdown-image-context'

const lowlight = createCachedLowlight(createLowlight(common))

const RichMarkdownCode = Code.extend({
  // Permit linked code labels while keeping emphasis marks excluded.
  excludes: 'code bold italic strike underline'
})

export function createRichMarkdownExtensions({
  codec,
  includePlaceholder = false,
  allowBase64Images = true,
  imageErrorLink = false,
  htmlSuperscriptLinks = false,
  htmlSuperscriptLinkContext
}: {
  codec: RichMarkdownEditorCodec
  includePlaceholder?: boolean
  allowBase64Images?: boolean
  imageErrorLink?: boolean
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
          // Inline, not inline-block: a shrink-to-fit wrapper collapses an SVG that has a viewBox but no width to 0×0.
          dom.style.display = 'inline'
          dom.style.lineHeight = '0'

          const img = document.createElement('img')
          img.draggable = false
          // Undo preflight's block, middle-aligned images so text keeps flowing around them as before.
          img.style.display = 'inline-block'
          img.style.verticalAlign = 'baseline'
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
          const errorLink = imageErrorLink
            ? attachRichMarkdownImageErrorLink(dom, img, () => currentSrc)
            : undefined
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
              errorLink?.update(newSrc !== currentSrc)
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
      allowBase64: allowBase64Images,
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
