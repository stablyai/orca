import { createContext } from 'react'
import type { Element, ElementContent } from 'hast'

// Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan and their presentation forms.
const RTL_LETTERS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g
const LTR_LETTERS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g

export type NativeChatTextDirection = 'rtl' | 'ltr'

/** Majority vote, so a few English terms inside an Arabic sentence keep it right to left. */
export function textDirectionOf(text: string): NativeChatTextDirection | undefined {
  const rtl = text.match(RTL_LETTERS)?.length ?? 0
  const ltr = text.match(LTR_LETTERS)?.length ?? 0
  if (rtl === 0 && ltr === 0) {
    return undefined
  }
  return rtl >= ltr ? 'rtl' : 'ltr'
}

export function hasRightToLeftText(text: string): boolean {
  RTL_LETTERS.lastIndex = 0
  return RTL_LETTERS.test(text)
}

/** Code reads left to right whatever language the prose is in, so it never votes. */
export function markdownProseText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
}

export function hastProseText(node: Element | ElementContent | undefined): string {
  if (!node) {
    return ''
  }
  if (node.type === 'text') {
    return node.value
  }
  if (node.type !== 'element' || node.tagName === 'code' || node.tagName === 'pre') {
    return ''
  }
  return node.children.map(hastProseText).join('')
}

/** The message's direction; blocks set `dir` only where they differ from it. */
export const NativeChatTextDirectionContext = createContext<{
  message: NativeChatTextDirection | undefined
  bidi: boolean
}>({ message: undefined, bidi: false })

/** `dir` for one block, or undefined when it just follows the message. */
export function blockTextDirection(
  node: Element | undefined,
  context: { message: NativeChatTextDirection | undefined; bidi: boolean }
): NativeChatTextDirection | undefined {
  if (!context.bidi) {
    return undefined
  }
  const direction = textDirectionOf(hastProseText(node))
  return direction === (context.message ?? 'ltr') ? undefined : direction
}
