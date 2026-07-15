import type { BrowserSessionProfile, WebAiAccount, WebAiProvider } from '../../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

type WebAiAccountDraftBase = {
  label: string
  profileId: string | null
}

export type WebAiAccountDraft =
  | (WebAiAccountDraftBase & {
      provider: Exclude<WebAiProvider, 'custom'>
    })
  | (WebAiAccountDraftBase & {
      provider: 'custom'
      customServiceLabel: string
      customHomeUrl: string
      customCookieDomains: string[]
    })

export function buildWebAiAccountFromDraft(args: {
  draft: WebAiAccountDraft
  profile: BrowserSessionProfile
  id: string
  createdAt: number
}): WebAiAccount {
  const { draft, profile } = args
  const base: WebAiAccount = {
    id: args.id,
    provider: draft.provider,
    label: draft.label,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    profileId: profile.id,
    sessionPartition: profile.partition,
    createdAt: args.createdAt
  }
  return draft.provider === 'custom'
    ? {
        ...base,
        customServiceLabel: draft.customServiceLabel,
        customHomeUrl: draft.customHomeUrl,
        customCookieDomains: draft.customCookieDomains
      }
    : base
}
