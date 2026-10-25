import type { RemoteBrowserPageHandle } from '../store/slices/browser'

type RestoredBrowserHandleSource = {
  // Optional: reachability can be observed before the browser slice has any handles to offer.
  remoteBrowserPageHandlesByPageId?: Record<string, RemoteBrowserPageHandle>
}

// Coalesce only in-flight attempts; early unreachable hydration must retry. Adoption spends restored markers to end retries.
const preparingEnvironmentIds = new Set<string>()
// Restart must bypass preparation aimed at the dead runtime; coalescing loses the only authority-change signal until timeout.
const environmentIdsAwaitingRepreparation = new Set<string>()

/** Start lazy desktop browser hosting for restored client-hosted environments so runtime attach can recover retained pages. Repeated reachability calls are idempotent; skip environments after adoption spends their markers. */
export async function ensureBrowserClientHostsForRestoredPages(
  state: RestoredBrowserHandleSource
): Promise<void> {
  for (const environmentId of restoredClientHostEnvironmentIds(state)) {
    await prepareBrowserClientHost(environmentId)
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
  await prepareBrowserClientHost(environmentId, true)
}

async function prepareBrowserClientHost(
  environmentId: string,
  repreparesWhenBusy = false
): Promise<void> {
  if (preparingEnvironmentIds.has(environmentId)) {
    if (repreparesWhenBusy) {
      environmentIdsAwaitingRepreparation.add(environmentId)
    }
    return
  }
  preparingEnvironmentIds.add(environmentId)
  try {
    // Registry reuses live leases and reserves no page state; this only claims hosting duty.
    const placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
      selector: environmentId,
      preference: 'auto'
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
  if (environmentIdsAwaitingRepreparation.delete(environmentId)) {
    await prepareBrowserClientHost(environmentId)
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

function restoredClientHostEnvironmentIds(state: RestoredBrowserHandleSource): string[] {
  const environmentIds = new Set<string>()
  for (const handle of Object.values(state.remoteBrowserPageHandlesByPageId ?? {})) {
    if (handle.restoredClientHosted === true) {
      environmentIds.add(handle.environmentId)
    }
  }
  return [...environmentIds]
}

export function resetRestoredBrowserClientHostAttachForTests(): void {
  preparingEnvironmentIds.clear()
  environmentIdsAwaitingRepreparation.clear()
}
