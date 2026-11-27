import type { Root } from 'hast'
import { visitParents } from 'unist-util-visit-parents'
import { parseBotDeepLink } from '../../../../../shared/bot-deep-link'

export function nativeChatBotHomeId(href: unknown): string | undefined {
  if (typeof href !== 'string' || !/^orca:\/\/bot\/[^/?#]+\/?$/.test(href)) {
    return undefined
  }
  return parseBotDeepLink(href)?.botId
}

// Derive the marker after HTML is parsed so authored attributes cannot supply a destination.
export function rehypeNativeChatBotHome(): (tree: Root) => void {
  return (tree) => {
    visitParents(tree, 'element', (node) => {
      if (node.tagName !== 'a') {
        return
      }
      delete node.properties.dataOrcaBotHome
      const href = node.properties.href
      if (typeof href === 'string' && nativeChatBotHomeId(href)) {
        node.properties.dataOrcaBotHome = href
      }
    })
  }
}
