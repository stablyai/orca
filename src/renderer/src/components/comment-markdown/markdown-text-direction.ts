import type { ElementContent } from 'hast'
import { dominantTextDirection } from '@/lib/text-direction'

function proseText(nodes: readonly ElementContent[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? node.value
        : node.type === 'element' && node.tagName !== 'code' && node.tagName !== 'pre'
          ? ` ${proseText(node.children)} `
          : ' '
    )
    .join('')
}

/** A markdown block's direction from its prose; code is left out, as it is always LTR. */
export function markdownBlockDirection(
  node: { children: readonly ElementContent[] } | undefined
): 'ltr' | 'rtl' | 'auto' {
  return (node && dominantTextDirection(proseText(node.children))) ?? 'auto'
}
