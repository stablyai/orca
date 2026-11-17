import { createContext, use, useMemo, type Context } from 'react'
import type { Components } from 'react-markdown'

// Why: renderers change with review-note state; passing them to react-markdown directly makes
// every element a new component type, which remounts the document and drops its scroll position.
// Stable types read the latest renderers from context and re-render in place instead.
export const MarkdownPreviewRenderersContext: Context<Components> = createContext<Components>({})

type MarkdownElementRenderer = (props: Record<string, unknown>) => React.ReactNode

const stableComponentTypes = new Map<string, MarkdownElementRenderer>()

function getStableComponentType(tag: string): MarkdownElementRenderer {
  let type = stableComponentTypes.get(tag)
  if (!type) {
    type = function MarkdownPreviewElement(props) {
      const renderers: Record<string, unknown> = use(MarkdownPreviewRenderersContext)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every preview renderer is a function component called with its own tag's props.
      const render = renderers[tag] as MarkdownElementRenderer
      return render(props)
    }
    stableComponentTypes.set(tag, type)
  }
  return type
}

export function useMarkdownPreviewStableComponents(renderers: Components): Components {
  const tags = Object.keys(renderers).join(',')
  return useMemo(() => {
    const components: Record<string, MarkdownElementRenderer> = {}
    for (const tag of tags.split(',')) {
      components[tag] = getStableComponentType(tag)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each key comes from the preview renderers and delegates to that tag's renderer.
    return components as Components
  }, [tags])
}
