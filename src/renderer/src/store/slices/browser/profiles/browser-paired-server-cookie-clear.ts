import type { BrowserProfileClearDefaultCookiesResult } from '../../../../../../shared/browser/runtime/runtime-browser-contracts'
import { BROWSER_PROFILE_COOKIE_CLEAR_CAPABILITY } from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { BrowserSliceGet } from '../browser-slice-contract'

const CLEAR_TIMEOUT_MS = 15_000

/** Older servers clear only Default, through browser.profileClearDefaultCookies. */
export function pairedServerClearsAnyProfileCookies(environmentId: string): boolean {
  return (
    readRuntimeStatuses()
      .get(environmentId)
      ?.status?.capabilities?.includes(BROWSER_PROFILE_COOKIE_CLEAR_CAPABILITY) === true
  )
}

/**
 * A server profile has two jars: this desktop's for its This-device pages (where Settings import
 * lands) and the server's for streamed pages, phones and agents. Clearing it signs out of both.
 */
export async function clearPairedServerProfileCookies(
  get: BrowserSliceGet,
  hostId: ExecutionHostId,
  environmentId: string,
  profileId: string,
  pairingRevision: number | undefined
): Promise<boolean> {
  const anyProfile = pairedServerClearsAnyProfileCookies(environmentId)
  if (!anyProfile && profileId !== 'default') {
    return false
  }
  const rpcOptions = {
    timeoutMs: CLEAR_TIMEOUT_MS,
    expectedEnvironmentPairingRevision: pairingRevision
  }
  const clearServer = async (): Promise<boolean> => {
    if (!anyProfile) {
      return (
        await callRuntimeRpc<BrowserProfileClearDefaultCookiesResult>(
          { kind: 'environment', environmentId },
          'browser.profileClearDefaultCookies',
          undefined,
          rpcOptions
        )
      ).cleared
    }
    // The executor id proves the profile id still names this server's profile, not a re-paired one's.
    const listing = await get().fetchBrowserSessionProfiles(hostId)
    if (
      !listing?.executorRuntimeId ||
      listing.pairingRevision !== pairingRevision ||
      !listing.profiles.some((profile) => profile.id === profileId)
    ) {
      return false
    }
    return (
      await callRuntimeRpc<BrowserProfileClearDefaultCookiesResult>(
        { kind: 'environment', environmentId },
        'browser.profileClearCookies',
        { profileId, executorRuntimeId: listing.executorRuntimeId },
        rpcOptions
      )
    ).cleared
  }
  const [clientCleared, serverCleared] = await Promise.all([
    window.api.browser
      .sessionClearCookiesForClientHost({ environmentId, profileId })
      .catch(() => false),
    clearServer().catch(() => false)
  ])
  // Null: this desktop doesn't host the server's pages, so it has no jar of theirs in use.
  return clientCleared !== false && serverCleared
}
