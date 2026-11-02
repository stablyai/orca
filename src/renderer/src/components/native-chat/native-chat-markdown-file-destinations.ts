import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat/native-chat-href-routing'
import { formatFileLinkLocation } from '../../../../shared/file-link-location'

type MarkdownNode = {
  type: string
  url?: string
  identifier?: string
  title?: string | null
  children?: MarkdownNode[]
}

const SCHEME_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * Sanitize keeps only the protocols it knows, so a `file:` link or image naming a file loses its
 * address before any chat code sees it. Rewrite those destinations to the
 * chat's own file hrefs first; the existing file link and image paths then open them on the
 * chat's host. Web links and plain paths are left as written.
 */
function rewriteFileDestinations(node: MarkdownNode, definitions: Map<string, MarkdownNode>): void {
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
