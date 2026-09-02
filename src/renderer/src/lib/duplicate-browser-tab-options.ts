import type { BrowserTab } from '../../../shared/browser-workspace-types'

export function buildDuplicatedBrowserTabOptions(
  source: Pick<BrowserTab, 'title' | 'sessionProfileId' | 'sessionPartition'>
): {
  title: string
  sessionProfileId: string | null
  sessionPartition: string | null
} {
  return {
    title: source.title,
    sessionProfileId: source.sessionProfileId ?? null,
    sessionPartition: source.sessionPartition ?? null
  }
}
