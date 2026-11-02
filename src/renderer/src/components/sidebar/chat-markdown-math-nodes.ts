/// <reference types="remark-math" />

import type { Nodes, Root } from 'mdast'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { VFile } from 'vfile'

declare module 'vfile' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging extends upstream file metadata.
  interface DataMap {
    chatMathSources: globalThis.Map<number, { source: string; complete: boolean }>
  }
}

declare module 'mdast' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers transient parser metadata.
  interface Data {
    mathLiteral?: boolean
    mathComplete?: boolean
    mathSource?: string
    mathDisplay?: boolean
  }
}

export const chatMathFromMarkdown: FromMarkdownExtension = {
  enter: {
    codeFencedFence() {
      const node = this.stack.at(-2)
      if (this.data.flowCodeInside && node?.type === 'code' && node.lang === 'math') {
        node.data = { ...node.data, mathComplete: true }
      }
    },
    chatMath(token) {
      this.enter({ type: 'inlineMath', value: '' }, token)
      this.buffer()
    }
  },
  exit: {
    characterEscape(token) {
      const parent = this.stack.at(-1)
      const text = parent && 'children' in parent ? parent.children.at(-1) : undefined
      if (text?.type === 'text' && ['\\[', '\\('].includes(this.sliceSerialize(token))) {
        text.data = { ...text.data, mathLiteral: true }
      }
    },
    chatMathData(token) {
      this.config.enter.data.call(this, token)
      this.config.exit.data.call(this, token)
    },
    chatMath(token) {
      const value = this.resume()
      const node = this.stack.at(-1)
      if (node?.type !== 'inlineMath' || !token.chatMath) {
        return
      }
      const { opener, closer, closed, flow } = token.chatMath
      node.value = closed ? value.trim() : opener + value
      node.data = {
        hName: flow ? 'div' : 'span',
        hProperties: closed
          ? {
              className: ['language-math', flow ? 'math-display' : 'math-inline']
            }
          : { className: ['whitespace-pre-wrap'] },
        hChildren: [{ type: 'text', value: node.value }],
        mathSource: opener + value + (closed ? closer : ''),
        mathComplete: closed,
        mathDisplay: opener !== '$' && opener !== '\\('
      }
      this.exit(token)
    }
  }
}

function displayMath(node: Nodes): void {
  if (node.type === 'link' || node.type === 'image') {
    return
  }
  if (
    node.type === 'paragraph' &&
    node.children.every(
      (child) =>
        (child.type === 'text' && !child.value.trim()) ||
        child.type === 'break' ||
        (child.type === 'inlineMath' &&
          child.data?.mathComplete === true &&
          child.data?.mathDisplay)
    )
  ) {
    for (const child of node.children) {
      if (child.type === 'inlineMath' && child.data?.hProperties?.className) {
        child.data.hProperties.className = ['language-math', 'math-display']
      }
    }
  }
  if ('children' in node) {
    node.children.forEach(displayMath)
  }
}

/** CommonMark accepts EOF fences; math requires an authored closing fence. */
export function chatMathCodeFences(node: Nodes, source: string): void {
  if (node.type === 'code' && node.lang === 'math' && node.position) {
    const authored = source.slice(node.position.start.offset, node.position.end.offset)
    node.data = {
      ...node.data,
      mathSource: authored,
      mathComplete: node.data?.mathComplete === true
    }
  }
  if ('children' in node) {
    node.children.forEach((child) => chatMathCodeFences(child, source))
  }
}

export function transformChatMath(tree: Root, file: VFile): void {
  chatMathCodeFences(tree, String(file))
  const sources = new Map<number, { source: string; complete: boolean }>()
  file.data.chatMathSources = sources
  // Link labels remain ordinary Markdown even when the label contains delimiters.
  function literalLinks(node: Nodes, inLink = false): void {
    if (
      (node.type === 'inlineMath' || (node.type === 'code' && node.lang === 'math')) &&
      node.position?.start.offset !== undefined
    ) {
      sources.set(node.position.start.offset, {
        source: String(node.data?.mathSource ?? node.value),
        complete: node.data?.mathComplete === true
      })
    }
    if ('children' in node) {
      for (const child of node.children) {
        if ((inLink || node.type === 'link') && child.type === 'inlineMath') {
          child.data = {
            hName: 'span',
            hChildren: [{ type: 'text', value: String(child.data?.mathSource ?? child.value) }]
          }
        }
        literalLinks(child, inLink || node.type === 'link')
      }
    }
  }
  literalLinks(tree)
  displayMath(tree)
}
