import type { StoreApi } from 'zustand'
import type { AppState } from '../types'

/** High-rate fields a background agent update writes; their readers subscribe through a channel. */
const CHANNEL_FIELDS = [
  'agentStatusByPaneKey',
  'agentStatusEpoch',
  // Sort epochs stay root: about 25 writers across worktrees, repos and tabs bump them, and live
  // status writes change them only on ordering transitions.
  'agentConversationsByPaneKey'
] as const satisfies readonly (keyof AppState)[]

export type AppStoreChannelField = (typeof CHANNEL_FIELDS)[number]

const channelFields: ReadonlySet<string> = new Set(CHANNEL_FIELDS)

/** What a root selector may read: a write touching only channel fields need not wake it. */
export type RootSelectorState = Omit<AppState, AppStoreChannelField>

export type AppStoreRootSelectorApi = {
  /** For the app store hook only: skipped by writes that change channel fields alone. */
  subscribeRootSelector: (listener: () => void) => () => void
}

/** True when every key whose value changed is channel-owned, so root listeners cannot observe it. */
export function isChannelOnlyWrite(
  previous: AppState,
  next: AppState,
  requested: Partial<AppState>
): boolean {
  let changed = false
  for (const key of Object.keys(requested)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keys come from a Partial<AppState> patch.
    const field = key as keyof AppState
    if (Object.is(previous[field], next[field])) {
      continue
    }
    if (!channelFields.has(key)) {
      return false
    }
    changed = true
  }
  return changed
}

/** The app store hook: selectors see only root fields; getState and subscribers stay complete. */
export type AppStore = (<U>(selector: (state: RootSelectorState) => U) => U) & StoreApi<AppState>

/** The store api as the ownership boundary extended it; inner creators run after the extension. */
export function channelApi<TApi extends object>(api: TApi): TApi & AppStoreRootSelectorApi {
  if (!('subscribeRootSelector' in api)) {
    throw new Error('subscribeRootSelector is installed by the agent-status ownership boundary')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: presence checked above; the boundary installs the router's function.
  return api as TApi & AppStoreRootSelectorApi
}
