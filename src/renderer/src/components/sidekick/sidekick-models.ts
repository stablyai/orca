import claudeUrl from '../../../../../resources/claude.webp?url'
import opencodeUrl from '../../../../../resources/opencode.webp?url'
import gremlinUrl from '../../../../../resources/gremlin.webp?url'

// Why: bundled defaults so the overlay always has something to render when the
// user hasn't uploaded a custom image. Vite's `?url` import hashes each asset
// at build time so they participate in the normal caching pipeline.
export const DEFAULT_SIDEKICK_ID = 'claude-the-mage'
export const OPENCODE_SIDEKICK_ID = 'opencode-the-rogue'
export const GREMLIN_SIDEKICK_ID = 'gremlin-the-trickster'

export type BundledSidekickId =
  | typeof DEFAULT_SIDEKICK_ID
  | typeof OPENCODE_SIDEKICK_ID
  | typeof GREMLIN_SIDEKICK_ID

export type BundledSidekick = {
  id: BundledSidekickId
  label: string
  url: string
}

export const BUNDLED_SIDEKICKS: readonly BundledSidekick[] = [
  {
    id: DEFAULT_SIDEKICK_ID,
    label: 'Claudino',
    url: claudeUrl
  },
  {
    id: OPENCODE_SIDEKICK_ID,
    label: 'OpenCode',
    url: opencodeUrl
  },
  {
    id: GREMLIN_SIDEKICK_ID,
    label: 'Gremlin',
    url: gremlinUrl
  }
] as const

export const BUNDLED_SIDEKICK: BundledSidekick = BUNDLED_SIDEKICKS[0]

export function isBundledSidekickId(id: string | undefined): boolean {
  return BUNDLED_SIDEKICKS.some((s) => s.id === id)
}

export function findBundledSidekick(id: string | undefined): BundledSidekick | undefined {
  return BUNDLED_SIDEKICKS.find((s) => s.id === id)
}
