import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../../shared/native-chat/native-chat-href-routing'
import { formatFileLinkLocation } from '../../../../../shared/file-links/file-link-location'
import { filePreviewForPath } from '../../../../../shared/file-preview/file-preview-kind'
import {
  authoredNativeChatLinkUrl,
  isDetectedNativeChatPathLink
} from '../../../../../shared/native-chat/native-chat-file-link-tree'

type MarkdownNode = {
  type: string
  url?: string
  alt?: string
  identifier?: string
  title?: string | null
  data?: unknown
  children?: MarkdownNode[]
}

const SCHEME_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/
const NETWORK_PATH_PATTERN = /^[\\/]{2}/

type FileRewrite = { link: string; image: string }

/** A definition's destination, resolved once however many references share it. */
type ResolvedDefinition = {
  title?: string | null
  previewHref: string | null
  rewrite: FileRewrite | null
}

function isImageNode(node: MarkdownNode): boolean {
  return node.type === 'image' || node.type === 'imageReference'
}

function containsImage(node: MarkdownNode): boolean {
  return isImageNode(node) || (node.children ?? []).some(containsImage)
}

/** The host file a destination names, as the literal chat file href images read it through. */
function hostImageHref(url: string | undefined): string | null {
  const route = routeNativeChatHref(url)
  return route.kind === 'file' &&
    !NETWORK_PATH_PATTERN.test(route.pathText) &&
    filePreviewForPath(route.pathText)?.kind === 'image'
    ? createNativeChatFileHref(route.pathText, 'literal')
    : null
}

function previewHref(
  node: MarkdownNode,
  definition: ResolvedDefinition | undefined
): string | null {
  return definition
    ? definition.previewHref
    : hostImageHref(authoredNativeChatLinkUrl(node) ?? node.url)
}

/**
 * Agents usually name the images they make as links. A paragraph's authored links to image files on
 * the chat's host get a following paragraph with those images; the links stay as written. Only the
 * written destination decides, so the transcript and whole-message image discovery (which does not
 * linkify plain-text paths) select the same images.
 */
function linkedImagePreviews(
  paragraph: MarkdownNode,
  definitions: Map<string, ResolvedDefinition>
): MarkdownNode | null {
  const shown = new Set<string>()
  const linked = new Set<string>()
  function visit(node: MarkdownNode): void {
    for (const child of node.children ?? []) {
      const definition = child.identifier
        ? definitions.get(child.identifier.toUpperCase())
        : undefined
      if (isImageNode(child)) {
        const href = previewHref(child, definition)
        if (href) {
          shown.add(href)
        }
      } else if (
        (child.type === 'link' || (child.type === 'linkReference' && definition)) &&
        !isDetectedNativeChatPathLink(child) &&
        !containsImage(child)
      ) {
        const href = previewHref(child, definition)
        if (href) {
          linked.add(href)
        }
      }
      visit(child)
    }
  }
  visit(paragraph)
  const previews = [...linked].filter((href) => !shown.has(href))
  return previews.length > 0
    ? {
        type: 'paragraph',
        children: previews.map((url) => ({ type: 'image', url, alt: '' }))
      }
    : null
}

function fileRewrite(url: string | undefined): FileRewrite | null {
  const route = url && SCHEME_PREFIX_PATTERN.test(url) ? routeNativeChatHref(url) : null
  return route?.kind === 'file'
    ? {
        link: createNativeChatFileHref(formatFileLinkLocation(route)),
        image: createNativeChatFileHref(route.pathText, 'literal')
      }
    : null
}

/**
 * Sanitize keeps only the protocols it knows, so a `file:` link or image naming a file loses its
 * address before any chat code sees it. Rewrite those destinations to the
 * chat's own file hrefs first; the existing file link and image paths then open them on the
 * chat's host. Web links and plain paths are left as written.
 */
function rewriteFileDestinations(
  node: MarkdownNode,
  definitions: Map<string, ResolvedDefinition>
): void {
  const definition =
    (node.type === 'linkReference' || node.type === 'imageReference') && node.identifier
      ? definitions.get(node.identifier.toUpperCase())
      : undefined
  const rewrite = definition
    ? definition.rewrite
    : node.type === 'link' || node.type === 'image'
      ? fileRewrite(node.url)
      : null
  if (rewrite) {
    if (definition) {
      // One definition can serve both images (literal paths) and links (locations).
      node.type = node.type === 'imageReference' ? 'image' : 'link'
      node.title = definition.title
    }
    node.url = node.type === 'image' ? rewrite.image : rewrite.link
  }
  if (!node.children) {
    return
  }
  // One pass builds the new child list, so many previewing paragraphs stay linear.
  let children: MarkdownNode[] | undefined
  node.children.forEach((child, index) => {
    const previews = child.type === 'paragraph' ? linkedImagePreviews(child, definitions) : null
    rewriteFileDestinations(child, definitions)
    if (previews && !children) {
      children = node.children!.slice(0, index)
    }
    children?.push(child)
    // Preview sources are already chat file hrefs, so the rewrite has nothing to do there.
    if (previews) {
      children!.push(previews)
    }
  })
  if (children) {
    node.children = children
  }
}

export function remarkNativeChatFileDestinations(): (tree: MarkdownNode) => void {
  return (tree) => {
    const definitions = new Map<string, ResolvedDefinition>()
    function collectDefinitions(node: MarkdownNode): void {
      if (node.type === 'definition' && node.identifier) {
        const identifier = node.identifier.toUpperCase()
        if (!definitions.has(identifier)) {
          definitions.set(identifier, {
            title: node.title,
            previewHref: hostImageHref(node.url),
            rewrite: fileRewrite(node.url)
          })
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
