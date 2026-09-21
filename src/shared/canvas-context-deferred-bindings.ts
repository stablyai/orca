import {
  canvasContextBindingSchema,
  type CanvasContextBinding,
  type CanvasContextDeferredBinding
} from './canvas-agent-context'

export function sameCanvasBindingSnapshot(
  first: CanvasContextBinding[],
  second: CanvasContextBinding[]
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (binding, index) =>
        JSON.stringify(canvasContextBindingSchema.parse(binding)) ===
        JSON.stringify(canvasContextBindingSchema.parse(second[index]))
    )
  )
}

export function mergeDeferredCanvasBindings(
  bindings: CanvasContextBinding[],
  deferred: CanvasContextDeferredBinding[],
  previous: CanvasContextBinding[] = []
): CanvasContextBinding[] {
  return [
    ...bindings,
    ...deferred.flatMap(({ nodeId, name, peers, collaborationPaused, notes }) => {
      const binding = previous.find((item) => item.nodeId === nodeId)
      // Missing observations must not erase the host's session identity fence.
      return binding
        ? [
            canvasContextBindingSchema.parse({
              ...binding,
              name,
              peers,
              collaborationPaused,
              notes
            })
          ]
        : []
    })
  ]
}
