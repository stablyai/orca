import type { JSONContent } from '@tiptap/core'

type MarkdownCodeBlockRenderHelpers = {
  renderChildren: (nodes: JSONContent[]) => string
}

function longestFenceRun(text: string, character: '`' | '~'): number {
  let longest = 0
  let current = 0
  for (const value of text) {
    if (value === character) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

function chooseFence(text: string, language: string): { character: '`' | '~'; length: number } {
  const backtickLength = Math.max(3, longestFenceRun(text, '`') + 1)
  const tildeLength = Math.max(3, longestFenceRun(text, '~') + 1)
  return language.includes('`') || tildeLength < backtickLength
    ? { character: '~', length: tildeLength }
    : { character: '`', length: backtickLength }
}

export function renderRichMarkdownCodeBlock(
  node: JSONContent,
  helpers: MarkdownCodeBlockRenderHelpers
): string {
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
  const body = helpers.renderChildren(node.content ?? [])
  const fence = chooseFence(body, language)
  const marker = fence.character.repeat(fence.length)
  return [
    `${marker}${language.startsWith(fence.character) ? ' ' : ''}${language}`,
    body,
    marker
  ].join('\n')
}
