import { createContext, useContext, useMemo } from 'react'
import type { Root, Nodes } from 'mdast'
import type { Components } from 'react-markdown'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import {
  compactCommentMarkdownComponents,
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/comment-markdown-element-renderers'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import { NativeChatMarkdownResourceImage } from './NativeChatMarkdownResourceImage'

function rewriteSandboxReferences(node: Nodes): void {
  if (
    (node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
    /^sandbox:/i.test(node.url)
  ) {
    const route = routeNativeChatHref(node.url)
    if (route.kind === 'file') {
      node.url = createNativeChatFileHref(route.pathText, 'sandbox')
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      rewriteSandboxReferences(child)
    }
  }
}

/** Resolve before sanitize; no custom browser scheme is enabled on shared Markdown surfaces. */
export function remarkNativeChatSandboxResources() {
  return (tree: Root): void => rewriteSandboxReferences(tree)
}

export const NativeChatResourceRenderContext = createContext<{
  onLinkClick?: CommentMarkdownLinkClickHandler
  Image: Components['img']
}>({ Image: compactCommentMarkdownComponents.img })

const ResourceImage: NonNullable<Components['img']> = (props) => {
  const { onLinkClick, Image } = useContext(NativeChatResourceRenderContext)
  const src = typeof props.src === 'string' ? props.src : undefined
  const route = routeNativeChatHref(src)
  if (route.kind === 'file' && route.pathKind === 'literal') {
    return (
      <NativeChatMarkdownResourceImage
        path={route.pathText}
        alt={props.alt ?? ''}
        onLinkClick={onLinkClick}
      />
    )
  }
  return Image ? <Image alt={props.alt} src={props.src} /> : <img {...props} />
}

export function useNativeChatResourceMarkdownExtension(
  extension: CommentMarkdownExtension | undefined
): CommentMarkdownExtension {
  return useMemo(
    () => ({
      remarkPlugins: [...(extension?.remarkPlugins ?? []), remarkNativeChatSandboxResources],
      sanitizeAttributes: extension?.sanitizeAttributes ?? {},
      components: { ...extension?.components, img: ResourceImage }
    }),
    [extension]
  )
}
