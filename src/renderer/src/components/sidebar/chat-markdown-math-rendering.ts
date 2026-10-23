import type { Element, Root, RootContent } from 'hast'
import rehypeKatex from 'rehype-katex'
import { visit, SKIP } from 'unist-util-visit'
import type { VFile } from 'vfile'

const typeset = rehypeKatex({ trust: false, maxSize: 20, maxExpand: 1000, strict: 'ignore' })

/** Sanitized input enters KaTeX; invalid formulas keep readable source without error UI. */
export function rehypeChatMath(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    visit(tree, 'element', (element, index, parent) => {
      const mathElement =
        element.tagName === 'pre'
          ? element.children.find(
              (child): child is Element => child.type === 'element' && child.tagName === 'code'
            )
          : element
      const classes = mathElement?.properties.className
      if (
        !parent ||
        index === undefined ||
        !Array.isArray(classes) ||
        !classes.some((name) =>
          ['language-math', 'math-inline', 'math-display'].includes(String(name))
        )
      ) {
        return
      }
      const source =
        file.data.chatMathSources?.get(element.position?.start.offset ?? -1) ??
        (mathElement?.children ?? [])
          .filter((child) => child.type === 'text')
          .map((child) => child.value)
          .join('')
      const fragment: Root = { type: 'root', children: [element] }
      const messagesBefore = file.messages.length
      typeset(fragment, file)
      const invalid = file.messages.length > messagesBefore
      const children = invalid ? [{ type: 'text' as const, value: source }] : fragment.children
      const display = classes.includes('math-display') || element.tagName === 'pre'
      const content = children.filter(
        (child): child is Exclude<RootContent, { type: 'doctype' }> => child.type !== 'doctype'
      )
      const wrapper: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          dataMathSource: source,
          ...(invalid
            ? { className: ['whitespace-pre-wrap'] }
            : display
              ? {
                  className: ['block', 'max-w-full', 'overflow-x-auto', 'overflow-y-hidden'],
                  tabIndex: 0,
                  ariaLabel: 'Scroll display equation'
                }
              : {})
        },
        children:
          display && !invalid
            ? [
                {
                  type: 'element',
                  tagName: 'span',
                  properties: { className: ['inline-block', 'w-max', 'min-w-full'] },
                  children: content
                }
              ]
            : content
      }
      parent.children[index] = wrapper
      return SKIP
    })
  }
}
