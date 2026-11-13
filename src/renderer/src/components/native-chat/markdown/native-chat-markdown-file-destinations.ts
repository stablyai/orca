import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../../shared/native-chat/native-chat-href-routing'
import { formatFileLinkLocation } from '../../../../../shared/file-links/file-link-location'

type MarkdownNode = {
  type: string
  value?: string
  alt?: string | null
  url?: string
  identifier?: string
  title?: string | null
  children?: MarkdownNode[]
}

const SCHEME_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/
const IMAGE_DESTINATION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i

function isImageDestination(url: string | undefined): url is string {
  return Boolean(url && IMAGE_DESTINATION_PATTERN.test(url.split(/[?#]/, 1)[0]!))
}

/** A paragraph holding only a text link to an image shows that image instead of a link. */
function promoteImageLinkParagraph(
  paragraph: MarkdownNode,
  definitions: Map<string, MarkdownNode>
): void {
  const [link, ...rest] = (paragraph.children ?? []).filter(
    (child) => child.type !== 'text' || child.value?.trim()
  )
  if (
    rest.length > 0 ||
    !link ||
    (link.type !== 'link' && link.type !== 'linkReference') ||
    !link.children?.every((child) => child.type === 'text')
  ) {
    return
  }
  const definition =
    link.type === 'linkReference' && link.identifier
      ? definitions.get(link.identifier.toUpperCase())
      : undefined
  const url = definition?.url ?? link.url
  if (!isImageDestination(url)) {
    return
  }
  const text = link.children.map((child) => child.value ?? '').join('')
  paragraph.children = [
    {
      type: 'image',
      url,
      title: definition?.title ?? link.title,
      alt: text === url ? '' : text
    }
  ]
}

/**
 * Sanitize keeps only the protocols it knows, so a `file:` link or image naming a file loses its
 * address before any chat code sees it. Rewrite those destinations to the
 * chat's own file hrefs first; the existing file link and image paths then open them on the
 * chat's host. Web links and plain paths are left as written.
 */
function rewriteFileDestinations(node: MarkdownNode, definitions: Map<string, MarkdownNode>): void {
  if (node.type === 'paragraph') {
    promoteImageLinkParagraph(node, definitions)
  }
  const definition =
    (node.type === 'linkReference' || node.type === 'imageReference') && node.identifier
      ? definitions.get(node.identifier.toUpperCase())
      : undefined
  const url = definition?.url ?? node.url
  if (
    (definition || node.type === 'link' || node.type === 'image') &&
    url &&
    SCHEME_PREFIX_PATTERN.test(url)
  ) {
    const route = routeNativeChatHref(url)
    if (route.kind === 'file') {
      if (definition) {
        // One definition can serve both images (literal paths) and links (locations).
        node.type = node.type === 'imageReference' ? 'image' : 'link'
        node.title = definition.title
      }
      node.url =
        node.type === 'image'
          ? createNativeChatFileHref(route.pathText, 'literal')
          : createNativeChatFileHref(formatFileLinkLocation(route))
    }
  }
  for (const child of node.children ?? []) {
    rewriteFileDestinations(child, definitions)
  }
}

export function remarkNativeChatFileDestinations(): (tree: MarkdownNode) => void {
  return (tree) => {
    const definitions = new Map<string, MarkdownNode>()
    function collectDefinitions(node: MarkdownNode): void {
      if (node.type === 'definition' && node.identifier) {
        const identifier = node.identifier.toUpperCase()
        if (!definitions.has(identifier)) {
          definitions.set(identifier, node)
        }
      }
      for (const child of node.children ?? []) {
        collectDefinitions(child)
      }
    }
    collectDefinitions(tree)
    rewriteFileDestinations(tree, definitions)
  }
}
