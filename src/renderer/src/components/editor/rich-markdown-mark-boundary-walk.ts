import { Extension } from '@tiptap/core'

export type MarkdownNodeLike = {
  type?: string
  text?: string
  marks?: (string | { type?: string; attrs?: Record<string, unknown> })[]
}

type BoundaryWalk = (nodes: MarkdownNodeLike[], ...rest: unknown[]) => unknown

/** Rewrites the node list the walk is about to render. */
export type NodeRewrite = (nodes: MarkdownNodeLike[]) => MarkdownNodeLike[]

/** Rewrites the markdown the walk produced. */
export type OutputRewrite = (markdown: string) => string

/**
 * Wraps the markdown manager's mark-boundary walk so several extensions can
 * adjust the nodes going in and the markdown coming out. One wrapper rather than
 * one per extension because each would otherwise replace the previous one's.
 */
export function createMarkBoundaryWalkExtension(options: {
  name: string
  rewriteNodes?: NodeRewrite
  rewriteOutput?: OutputRewrite
}): Extension {
  return Extension.create({
    name: options.name,
    // Why: the lowest priority runs after `Markdown` publishes the manager.
    priority: 1,

    onBeforeCreate() {
      const manager = this.editor.markdown as unknown as Record<string, unknown> | undefined
      if (!manager) {
        return
      }
      const own = Object.hasOwn(manager, 'renderNodesWithMarkBoundaries')
      const source = own
        ? manager
        : (Object.getPrototypeOf(manager) as Record<string, unknown> | null)
      const walk = source?.renderNodesWithMarkBoundaries as BoundaryWalk | undefined
      if (typeof walk !== 'function') {
        return
      }
      const { rewriteNodes, rewriteOutput } = options
      manager.renderNodesWithMarkBoundaries = function (
        this: unknown,
        nodes: MarkdownNodeLike[],
        ...rest: unknown[]
      ) {
        const input = nodes ?? []
        const rendered = walk.call(this, rewriteNodes ? rewriteNodes(input) : input, ...rest)
        if (typeof rendered !== 'string' || !rewriteOutput) {
          return rendered
        }
        return rewriteOutput(rendered)
      } as BoundaryWalk
    }
  })
}
