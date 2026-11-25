import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { ProviderAccountSelection } from '@/runtime/provider-accounts/observations/runtime-provider-account-selection'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView,
  type ProviderAccountRuntimeView
} from '../../../provider-accounts/provider-account-visibility'
import type {
  CodexAccountActionRunner,
  ProviderAccountVisibilityOptions
} from '../accounts-pane-types'
import { PartialAccountUpdateError } from '../accounts-pane-partial-update'

type Account = Parameters<typeof getProviderAccountRuntime>[0]
type Selection = Parameters<typeof providerAccountIsActiveInView>[1]
type Lane = { runtime: 'host' | 'wsl'; wslDistro: string | null }

/** Accounts System default's Active badge and lanes judge; an unknown remote platform hides WSL rows. */
export function systemDefaultCandidates<T extends Account>(
  roster: readonly T[],
  visibleAccounts: readonly T[],
  options: ProviderAccountVisibilityOptions
): readonly T[] {
  return options.remoteOwner && options.ownerPlatform === null ? roster : visibleAccounts
}

/** System default is Active when no candidate account holds its own lane. */
export function isSystemDefaultActive<T extends Account>(
  state: Selection & { accounts: readonly T[] },
  visibleAccounts: readonly T[],
  view: ProviderAccountRuntimeView,
  options: ProviderAccountVisibilityOptions
): boolean {
  return !systemDefaultCandidates(state.accounts, visibleAccounts, options).some((account) =>
    providerAccountIsActiveInView(account, state, view, options)
  )
}

/** Lanes the pane's single System default clears: active remote WSL lanes first, the shown lane last. */
export function getSystemDefaultLanes(
  view: ProviderAccountRuntimeView,
  candidates: readonly Account[],
  selection: Selection,
  remoteOwner: boolean
): Lane[] {
  const shownLane: Lane = { runtime: view.runtime, wslDistro: view.wslDistro ?? null }
  if (!remoteOwner || view.runtime !== 'host') {
    return [shownLane]
  }
  // A remote Windows roster shows WSL rows beside host ones, so their active lanes must clear too.
  const wslDistros = new Set<string | null>()
  for (const account of candidates) {
    const lane = getProviderAccountRuntime(account)
    if (
      lane.runtime === 'wsl' &&
      providerAccountIsActiveInView(account, selection, lane, { remoteOwner: true })
    ) {
      wslDistros.add(lane.wslDistro)
    }
  }
  // Hidden WSL lanes go first so a failure leaves the lane the user sees untouched.
  return [
    ...Array.from(wslDistros, (wslDistro) => ({ runtime: 'wsl' as const, wslDistro })),
    shownLane
  ]
}

/** True when System default also clears WSL lanes besides the shown one, i.e. a remote Windows roster. */
export function clearsHiddenWslLanes(lanes: readonly Lane[]): boolean {
  return lanes.slice(0, -1).some((lane) => lane.runtime === 'wsl')
}

/** One runner action for every lane: the button stays disabled throughout, and the first failure stops it with one toast. */
export function runSystemDefaultSelect(
  lanes: readonly Lane[],
  owner: RuntimeClientTarget,
  run: CodexAccountActionRunner,
  select: (
    owner: RuntimeClientTarget,
    selection: ProviderAccountSelection
  ) => Promise<CodexRateLimitAccountsState>
): Promise<void> {
  return run(
    'select:system',
    async () => {
      let next: CodexRateLimitAccountsState | null = null
      const applied: Lane[] = []
      for (const lane of lanes) {
        try {
          next = await select(owner, { accountId: null, ...lane })
        } catch (error) {
          throw next ? new PartialAccountUpdateError(next, applied, error) : error
        }
        applied.push(lane)
      }
      if (!next) {
        throw new Error('No account lane to reset.')
      }
      return next
    },
    lanes
  )
}
