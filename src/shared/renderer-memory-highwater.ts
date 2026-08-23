/**
 * Shape of the renderer_memory_highwater breadcrumb series, shared so the
 * main-process retention budget cannot drift from what the renderer emits.
 */

// Why these levels: the OOM cluster dies at 90-97% of the heap limit; at the
// observed ~25MB/min ramp an 0.8-only profile is ~60min stale by then.
export const RENDERER_MEMORY_HIGHWATER_RATIOS = [0.6, 0.8, 0.9, 0.95] as const

// Each surface samples its own heap into the same breadcrumb ring.
export const RENDERER_MEMORY_SURFACES = ['main', 'dashboard-popout'] as const

export type RendererSurface = (typeof RENDERER_MEMORY_SURFACES)[number]

/**
 * One retained breadcrumb per (surface, threshold) profile.
 *
 * Why derived: a hand-written cap silently evicts oldest-first, so adding a
 * threshold would drop the near-death main-window profile these reports exist
 * to carry.
 */
export const MAX_RETAINED_RENDERER_MEMORY_BREADCRUMBS =
  RENDERER_MEMORY_HIGHWATER_RATIOS.length * RENDERER_MEMORY_SURFACES.length
