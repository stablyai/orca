import type { RemoteBrowserPageHandle } from '../../../store/slices/browser/browser-slice-contract'
import type { BrowserClientHostPlacementPreference } from '../../../../../shared/browser/client-hosting/browser-client-host-placement'

type RestoredBrowserHandleSource = {
  // Optional: reachability can be observed before the browser slice has any handles to offer.
  remoteBrowserPageHandlesByPageId?: Record<string, RemoteBrowserPageHandle>
}

// Coalesce only in-flight attempts; early unreachable hydration must retry. Adoption spends restored markers to end retries.
const preparingEnvironmentIds = new Set<string>()
// Restart must bypass preparation aimed at the dead runtime; coalescing loses the only authority-change signal until timeout.
const environmentIdsAwaitingRepreparation = new Map<string, BrowserClientHostPlacementPreference>()

/** Start lazy desktop browser hosting for restored client-hosted environments so runtime attach can recover retained pages. Repeated reachability calls are idempotent; skip environments after adoption spends their markers. */
export async function ensureBrowserClientHostsForRestoredPages(
  state: RestoredBrowserHandleSource
): Promise<void> {
  for (const environmentId of restoredClientHostEnvironmentIds(state)) {
    // Pages this desktop hosted stay here whatever Settings › Browser says for new pages.
    await prepareBrowserClientHost(
      environmentId,
      hasOwnClientHostedPage(state, environmentId) ? 'client' : 'auto',
      // A busy 'auto' attempt must not swallow this desktop's own pages.
      true
    )
  }
}

/** Reclaim hosting on runtime restart/contact return. replaceAuthority preserves live guests and inventories them to new authority; past lease grace, fresh hosting lets runtime re-place destroyed guests at last URLs. Nothing else observes these recovery edges. */
export async function ensureBrowserClientHostOnRuntimeContact(
  state: RestoredBrowserHandleSource,
  environmentId: string
): Promise<void> {
  if (!hasLiveClientHostedPage(state, environmentId)) {
    return
  }
  // Why re-prepare: an in-flight preparation began before this contact, so it may have failed.
  await prepareBrowserClientHost(
    environmentId,
    hasOwnClientHostedPage(state, environmentId) ? 'client' : 'auto',
    true
  )
}

async function prepareBrowserClientHost(
  environmentId: string,
  preference: BrowserClientHostPlacementPreference,
  repreparesWhenBusy = false
): Promise<void> {
  if (preparingEnvironmentIds.has(environmentId)) {
    if (repreparesWhenBusy) {
      const awaiting = environmentIdsAwaitingRepreparation.get(environmentId)
      environmentIdsAwaitingRepreparation.set(
        environmentId,
        awaiting === 'client' ? awaiting : preference
      )
    }
    return
  }
  preparingEnvironmentIds.add(environmentId)
  try {
    // Registry reuses live leases and reserves no page state; this only claims hosting duty.
    const placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
      selector: environmentId,
      preference
    })
    if (placement.kind !== 'client') {
      // Unanswered probes no longer throw; log failed relaunch recovery explicitly.
      console.warn(
        '[restored-client-hosted-browser] no client host for restored pages; preparation answered',
        placement.kind,
        'for',
        environmentId
      )
    }
  } catch (error) {
    // Contain failures in hydration/status updates or lose saving/unrelated state. Unhosted pages remain recoverable.
    console.warn(
      '[restored-client-hosted-browser] failed to start the browser client host for',
      environmentId,
      error
    )
  } finally {
    preparingEnvironmentIds.delete(environmentId)
  }
  const awaitingPreference = environmentIdsAwaitingRepreparation.get(environmentId)
  if (awaitingPreference) {
    environmentIdsAwaitingRepreparation.delete(environmentId)
    await prepareBrowserClientHost(environmentId, awaitingPreference)
  }
}

function hasLiveClientHostedPage(
  state: RestoredBrowserHandleSource,
  environmentId: string
): boolean {
  return Object.values(state.remoteBrowserPageHandlesByPageId ?? {}).some(
    (handle) =>
      handle.environmentId === environmentId &&
      (handle.placement?.kind === 'client' ||
        handle.stagedClientHosted === true ||
        handle.restoredClientHosted === true)
  )
}

/** Pages this desktop itself placed here; a server's snapshot alone can't override the setting. */
function hasOwnClientHostedPage(
  state: RestoredBrowserHandleSource,
  environmentId: string
): boolean {
  return Object.values(state.remoteBrowserPageHandlesByPageId ?? {}).some(
    (handle) =>
      handle.environmentId === environmentId &&
      (handle.stagedClientHosted === true || handle.placedHere === true)
  )
}

function restoredClientHostEnvironmentIds(state: RestoredBrowserHandleSource): string[] {
  const environmentIds = new Set<string>()
  for (const handle of Object.values(state.remoteBrowserPageHandlesByPageId ?? {})) {
    if (handle.restoredClientHosted === true) {
      environmentIds.add(handle.environmentId)
    }
  }
  return [...environmentIds]
}
