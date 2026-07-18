import type { BrowserTab } from '../../../shared/types'

export function buildDuplicatedBrowserTabOptions(
  source: Pick<BrowserTab, 'title' | 'sessionProfileId' | 'sessionPartition'> &
    Partial<Pick<BrowserTab, 'webAiAccountId'>>
): {
  title: string
  sessionProfileId: string | null
  sessionPartition: string | null
  webAiAccountId?: string | null
} {
  return {
    title: source.title,
    sessionProfileId: source.sessionProfileId ?? null,
    sessionPartition: source.sessionPartition ?? null,
    ...(source.webAiAccountId !== undefined
      ? { webAiAccountId: source.webAiAccountId ?? null }
      : {})
  }
}
