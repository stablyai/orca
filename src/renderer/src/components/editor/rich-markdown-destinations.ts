import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'

export const RichMarkdownLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      rawHref: { default: null, rendered: false },
      originalHref: { default: null, rendered: false }
    }
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: token.title || null,
      rawHref: extractRawDestination(token.raw, token.href),
      originalHref: token.href
    }),
  renderMarkdown: (node, helpers) => {
    const href =
      node.attrs?.href === node.attrs?.originalHref
        ? (node.attrs?.rawHref ?? node.attrs?.href ?? '')
        : (node.attrs?.href ?? '')
    const title = node.attrs?.title ?? ''
    const text = helpers.renderChildren(node)
    return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`
  }
})

function extractRawDestination(raw: string | undefined, href: string | undefined): string | null {
  if (!raw) {
    return null
  }
  const open = raw.indexOf('](')
  const close = raw.lastIndexOf(')')
  if (open === -1 || close <= open + 2) {
    return null
  }
  const destination = raw.slice(open + 2, close).trim()
  const titleStart = destination.search(/\s+["']|\s+\(/)
  const candidate = titleStart >= 0 ? destination.slice(0, titleStart) : destination
  const decoded = candidate
    .replace(/^<(.*)>$/, '$1')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
  return decoded === href ? candidate : null
}

export const RichMarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      rawSrc: { default: null, rendered: false },
      originalSrc: { default: null, rendered: false }
    }
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode('image', {
      src: token.href,
      alt: token.text || '',
      title: token.title,
      rawSrc: extractRawDestination(token.raw, token.href),
      originalSrc: token.href
    }),
  renderMarkdown: (node) => {
    const src =
      node.attrs?.src === node.attrs?.originalSrc
        ? (node.attrs?.rawSrc ?? node.attrs?.src ?? '')
        : (node.attrs?.src ?? '')
    const alt = node.attrs?.alt ?? ''
    const title = node.attrs?.title ?? ''
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`
  }
})
