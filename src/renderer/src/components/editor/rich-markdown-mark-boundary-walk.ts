import { Extension } from '@tiptap/core'

export type MarkdownNodeLike = {
  type?: string
  text?: string
  marks?: (string | { type?: string; attrs?: Record<string, unknown> })[]
}

type BoundaryWalk = (nodes: MarkdownNodeLike[], ...rest: unknown[]) => unknown

/**
 * One pass over the walk: the nodes going in and the markdown coming out. A
 * session per call rather than shared state because the walk recurses, so an
 * outer pass is still open while an inner one runs.
 */
export type MarkBoundarySession = {
  mask: (nodes: MarkdownNodeLike[]) => MarkdownNodeLike[]
  restore: (markdown: string) => string
}

/**
 * Wraps the markdown manager's mark-boundary walk so several extensions can
 * adjust the nodes going in and the markdown coming out. One wrapper rather than
 * one per extension because each would otherwise replace the previous one's.
 */
export function createMarkBoundaryWalkExtension(options: {
  name: string
  createSession: () => MarkBoundarySession
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
      const { createSession } = options
      manager.renderNodesWithMarkBoundaries = function (
        this: unknown,
        nodes: MarkdownNodeLike[],
        ...rest: unknown[]
      ) {
        const session = createSession()
        const rendered = walk.call(this, session.mask(nodes ?? []), ...rest)
        return typeof rendered === 'string' ? session.restore(rendered) : rendered
      } as BoundaryWalk
    }
  })
}
