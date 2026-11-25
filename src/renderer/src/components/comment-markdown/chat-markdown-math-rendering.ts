import type { Element, Root, RootContent } from 'hast'
import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { visit, SKIP } from 'unist-util-visit'
import type { VFile } from 'vfile'
import type { typesetChatMath } from './chat-markdown-math-typeset'

type Typeset = typeof typesetChatMath
let loaded: Typeset | undefined
let pending: Promise<Typeset | undefined> | undefined

export function useChatMathRendering(enabled: boolean): () => ReturnType<typeof rehypeChatMath> {
  const parsed = { complete: false }
  const [typeset, setTypeset] = useState(() => loaded)
  // Only a committed parse may request the shared optional typesetter.
  useEffect(() => {
    if (!enabled || !parsed.complete || typeset) {
      return
    }
    let active = true
    pending ??= import('./chat-markdown-math-typeset').then(
      (module) => (loaded = module.typesetChatMath),
      () => {
        pending = undefined
        return undefined
      }
    )
    void pending.then((render) => {
      if (active && render) {
        setTypeset(() => render)
      }
    })
    return () => {
      active = false
    }
  })
  return () => rehypeChatMath(typeset, parsed)
}

/** Sanitized input enters KaTeX; invalid formulas keep readable source without error UI. */
function rehypeChatMath(
  typeset: Typeset | undefined,
  parsed: { complete: boolean }
): (tree: Root, file: VFile) => void {
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
      const authored = file.data.chatMathSources?.get(element.position?.start.offset ?? -1)
      const source =
        authored?.source ??
        (mathElement?.children ?? [])
          .filter((child) => child.type === 'text')
          .map((child) => child.value)
          .join('')
      if (authored?.complete) {
        parsed.complete = true
      }
      const fragment: Root = { type: 'root', children: [element] }
      const messagesBefore = file.messages.length
      if (typeset && authored?.complete !== false) {
        typeset(fragment, file)
      }
      const invalid =
        !typeset || authored?.complete === false || file.messages.length > messagesBefore
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
                  role: 'group',
                  ariaLabel: translate(
                    'nativeChat.math.scrollDisplayEquation',
                    'Scroll display equation'
                  )
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
