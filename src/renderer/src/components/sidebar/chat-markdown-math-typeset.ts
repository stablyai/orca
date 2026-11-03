import type { ElementContent, Root } from 'hast'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import { toText } from 'hast-util-to-text'
import katex from 'katex'
import { SKIP, visitParents } from 'unist-util-visit-parents'
import type { VFile } from 'vfile'
import { BoundedMap } from '../../../../shared/bounded-map'

type MathResult = Readonly<{
  html?: string
  failure?: Readonly<{ name: string; message: string; title: string }>
}>
const settings = { trust: false, maxSize: 20, maxExpand: 1000, strict: 'ignore' } as const
const results = new BoundedMap<string, MathResult>({
  maxEntries: 1000,
  maxBytes: 4 * 1024 * 1024,
  // Include UTF-16 keys/payload and a fixed allowance for entry/descriptor/map bookkeeping.
  sizeOf: ({ html, failure }, key) =>
    256 +
    2 *
      (key.length +
        (html?.length ?? 0) +
        (failure ? failure.name.length + failure.message.length + failure.title.length : 0))
})

function renderMath(value: string, displayMode: boolean): MathResult {
  // All other effective options are fixed and owned by this cache instance.
  const key = `${displayMode ? 'display' : 'inline'}:${value}`
  const cached = results.get(key)
  if (cached) {
    return cached
  }
  let html: string | undefined
  let failure: MathResult['failure']
  try {
    html = katex.renderToString(value, { ...settings, displayMode, throwOnError: true })
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    failure = { name: cause.name, message: cause.message, title: String(error) }
    try {
      html = katex.renderToString(value, {
        ...settings,
        displayMode,
        strict: 'ignore',
        throwOnError: false
      })
    } catch {
      // The transformer rebuilds this uncommon error fallback from current input.
    }
  }
  const result = { html, failure }
  results.set(key, result)
  return result
}

// Preserve rehype-katex's scope/order/splice/SKIP semantics; only the pure kernel result is shared.
export function typesetChatMath(tree: Root, file: VFile): void {
  visitParents(tree, 'element', (element, parents) => {
    const classes = Array.isArray(element.properties.className) ? element.properties.className : []
    const languageMath = classes.includes('language-math')
    const mathDisplay = classes.includes('math-display')
    const mathInline = classes.includes('math-inline')
    let displayMode = mathDisplay
    if (!languageMath && !mathDisplay && !mathInline) {
      return
    }
    let parent = parents.at(-1)
    let scope = element
    if (
      element.tagName === 'code' &&
      languageMath &&
      parent?.type === 'element' &&
      parent.tagName === 'pre'
    ) {
      scope = parent
      parent = parents.at(-2)
      displayMode = true
    }
    if (!parent) {
      return
    }
    const value = toText(scope, { whitespace: 'pre' })
    const { html, failure } = renderMath(value, displayMode)
    if (failure) {
      const cause = new Error(failure.message)
      cause.name = failure.name
      file.message('Could not render math with KaTeX', {
        ancestors: [...parents, element],
        cause,
        place: element.position,
        ruleId: failure.name.toLowerCase(),
        source: 'rehype-katex'
      })
    }
    const children: ElementContent[] =
      html === undefined
        ? [
            {
              type: 'element',
              tagName: 'span',
              properties: {
                className: ['katex-error'],
                style: 'color:#cc0000',
                title: failure?.title
              },
              children: [{ type: 'text', value }]
            }
          ]
        : fromHtmlIsomorphic(html, { fragment: true }).children.filter(
            (child): child is ElementContent => child.type !== 'doctype'
          )
    const index = parent.children.indexOf(scope)
    parent.children.splice(index, 1, ...children)
    return SKIP
  })
}
