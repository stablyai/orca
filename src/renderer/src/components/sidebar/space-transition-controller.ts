/**
 * Lets the Space strip and the Space shortcuts reuse the sidebar pager's slide
 * instead of swapping instantly, without threading a callback through the tree.
 */

type SpaceTransitionHandler = (spaceId: string) => boolean

let handler: SpaceTransitionHandler | null = null

export function registerSpaceTransitionHandler(next: SpaceTransitionHandler): () => void {
  handler = next
  return () => {
    if (handler === next) {
      handler = null
    }
  }
}

/** False when nothing can animate — the caller should switch Spaces instantly. */
export function requestAnimatedSpaceTransition(spaceId: string): boolean {
  return handler?.(spaceId) ?? false
}
