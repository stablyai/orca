import { createContext } from 'react'
import type { Element, ElementContent } from 'hast'

// Letters only: Arabic-Indic digits share the script but are weak in bidi, so they never vote.
const RTL_LETTERS =
  /(?=\p{L})[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}]/gu
// Every other letter (Latin, Han, Cyrillic, ...) is strong left to right.
const LTR_LETTERS =
  /(?![\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}])\p{L}/gu

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

// A fence opens only at a line start; it closes on a matching fence line or runs to the end.
const FENCED_CODE =
  /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n(?:[\s\S]*?\n {0,3}\1[`~]*[ \t]*(?=\n|$)|[\s\S]*))?/gm

/** Code and link destinations are not read as prose, so they never vote. */
export function markdownProseText(markdown: string): string {
  return markdown
    .replace(FENCED_CODE, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/\]\([^)\s]*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, ']')
    .replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S+.*$/gm, '')
    .replace(/<(?:https?|mailto):[^>\s]*>/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
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

/** Direction of the nearest enclosing list, so a nested block is compared with its parent. */
export const NativeChatParentDirectionContext = createContext<NativeChatTextDirection | undefined>(
  undefined
)

/** `dir` for one block, or undefined when it just follows its parent block (or the message). */
export function blockTextDirection(
  node: Element | undefined,
  context: { message: NativeChatTextDirection | undefined; bidi: boolean },
  parent?: NativeChatTextDirection
): NativeChatTextDirection | undefined {
  if (!context.bidi) {
    return undefined
  }
  const direction = textDirectionOf(hastProseText(node))
  return direction === (parent ?? context.message ?? 'ltr') ? undefined : direction
}
