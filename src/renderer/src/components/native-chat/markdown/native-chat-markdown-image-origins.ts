import type { Element, Root as HastRoot } from 'hast'
import type { Root } from 'mdast'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import type { Options as RemarkRehypeOptions } from 'remark-rehype'
import { NativeChatHtmlSourceMaps } from './native-chat-markdown-html-source-map'
import { authoredMarkdownAnchor, type MappedMarkdown } from './native-chat-markdown-source-map'

export const NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY = 'dataOrcaImageOrigin'

export type NativeChatDocumentImageOrigin = {
  producer: 'authored-image' | 'authored-link-preview' | 'html-image'
  anchorStart: number
  outputKey?: string
  outputOrdinal?: number
}

type OriginNode = {
  data?: unknown
  position?: { start: { offset?: number } }
}

function createImageOriginNonce(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Image origin provenance requires secure randomness')
  }
  return createNonSecureContextUuid()
}

export class NativeChatMarkdownImageOrigins {
  readonly html: NativeChatHtmlSourceMaps
  readonly finalNodes = new WeakMap<Element, NativeChatDocumentImageOrigin>()
  private readonly capabilities = new Map<string, NativeChatDocumentImageOrigin>()
  private readonly nonce = createImageOriginNonce()
  private sequence = 0

  constructor(
    readonly source: MappedMarkdown,
    private readonly original: string,
    private readonly originalStart = 0
  ) {
    this.html = new NativeChatHtmlSourceMaps(source)
  }

  private mint(origin: NativeChatDocumentImageOrigin): string {
    const capability = `${this.nonce}:${this.sequence++}`
    this.capabilities.set(capability, origin)
    return capability
  }

  private stamp(node: OriginNode, origin: NativeChatDocumentImageOrigin): void {
    const data = node.data && typeof node.data === 'object' ? node.data : {}
    const properties =
      'hProperties' in data && data.hProperties && typeof data.hProperties === 'object'
        ? data.hProperties
        : {}
    node.data = {
      ...data,
      hProperties: { ...properties, [NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY]: this.mint(origin) }
    }
  }

  readonly authoredImages =
    () =>
    (tree: Root): void => {
      const visit = (node: Root | Root['children'][number]): void => {
        if (node.type === 'image' || node.type === 'imageReference') {
          const offset = node.position?.start.offset
          const anchor =
            offset === undefined ? null : authoredMarkdownAnchor(this.source, offset, 2)
          if (anchor !== null) {
            this.stamp(node, { producer: 'authored-image', anchorStart: anchor })
          }
        }
        if ('children' in node) {
          for (const child of node.children) {
            visit(child)
          }
        }
      }
      visit(tree)
    }

  readonly recordPreview = (image: OriginNode, link: OriginNode, href: string): void => {
    const offset = link.position?.start.offset
    const anchor = offset === undefined ? null : authoredMarkdownAnchor(this.source, offset, 1)
    if (anchor === null) {
      throw new Error('Generated image lost its authored link origin')
    }
    this.stamp(image, {
      producer: 'authored-link-preview',
      anchorStart: anchor,
      outputKey: href,
      outputOrdinal: 0
    })
  }

  readonly htmlHandler: NonNullable<RemarkRehypeOptions['handlers']>['html'] = (state, node) => {
    if (!state.options.allowDangerousHtml) {
      return undefined
    }
    const raw = { type: 'raw' as const, value: node.value }
    state.patch(node, raw)
    const result = state.applyData(node, raw)
    const value = this.html.values.get(node)
    if (!value) {
      throw new Error('Raw HTML lost its parsed input map')
    }
    this.html.values.set(result, value)
    return result
  }

  readonly rawImage = (node: { type: 'raw'; value: string }, offset: number): string | null => {
    const value = this.html.values.get(node)
    if (!value) {
      throw new Error('Raw image parser lost its input feed')
    }
    const anchor = authoredMarkdownAnchor(value, offset, 1)
    if (anchor === null) {
      return null
    }
    const originalOffset = anchor - this.originalStart
    if (this.original.slice(originalOffset, originalOffset + 4).toLowerCase() !== '<img') {
      return null
    }
    return this.mint({ producer: 'html-image', anchorStart: anchor })
  }

  readonly finalize =
    () =>
    (tree: HastRoot): void => {
      const visit = (node: HastRoot | HastRoot['children'][number]): void => {
        if (node.type === 'element' && node.tagName === 'img') {
          const capability = node.properties[NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY]
          const origin =
            typeof capability === 'string' ? this.capabilities.get(capability) : undefined
          delete node.properties[NATIVE_CHAT_IMAGE_ORIGIN_PROPERTY]
          if (origin) {
            this.finalNodes.set(node, origin)
          }
        }
        if ('children' in node) {
          for (const child of node.children) {
            visit(child)
          }
        }
      }
      visit(tree)
      this.capabilities.clear()
    }
}
