import type { RemoteBrowserPageHandle } from '../store/slices/browser'

type RestoredBrowserHandleSource = {
  // Optional: reachability can be observed before the browser slice has any handles to offer.
  remoteBrowserPageHandlesByPageId?: Record<string, RemoteBrowserPageHandle>
}

// Why in flight rather than ever-attempted: hydration can run before the environment is reachable,
// and that attempt has to be retryable. What stops the retries is the restored marker itself --
// adoption spends it the moment the host republishes the page.
const preparingEnvironmentIds = new Set<string>()
// Coalescing an ordinary retry is fine, but a restart must not be swallowed by a preparation still
// aimed at the runtime that just died -- that request can hang until its RPC times out, and dropping
// the one signal that the authority changed is exactly how the rows get lost.
const environmentIdsAwaitingRepreparation = new Set<string>()

/**
 * Start this desktop's browser client host for every environment the restored session says it was
 * hosting pages for. The host is otherwise started lazily on the create path, so after a relaunch
 * the runtime never sees an attach and never hands the retained pages back.
 *
 * Safe to call again whenever an environment becomes reachable: preparation is idempotent per
 * environment, and an environment with no restored client-hosted rows left is skipped entirely.
 */
export async function ensureBrowserClientHostsForRestoredPages(
  state: RestoredBrowserHandleSource
): Promise<void> {
  for (const environmentId of restoredClientHostEnvironmentIds(state)) {
    await prepareBrowserClientHost(environmentId)
  }
}

/**
 * Re-claims hosting duty after the runtime process restarted under a new id.
 *
 * The guests are still alive in this desktop's webviews, but the runtime that placed them is gone
 * and the replacement knows nothing about them. Preparing again drives the host registry down its
 * `replaceAuthority` path, which keeps the guests and re-attaches with a page inventory the new
 * runtime can adopt. Without this nothing observes the id change and the rows are simply lost.
 */
export async function ensureBrowserClientHostForRestartedRuntime(
  state: RestoredBrowserHandleSource,
  environmentId: string
): Promise<void> {
  if (!hasLiveClientHostedPage(state, environmentId)) {
    return
  }
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
    // Idempotent per environment: the registry returns the live lease when one is already up, and
    // reserves no per-page state, so this only claims hosting duty.
    const placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
      selector: environmentId,
      preference: 'auto'
    })
    if (placement.kind !== 'client') {
      // Why still worth a line: preparation stopped throwing when the probe cannot answer, so
      // without this a relaunch that never recovers the retained pages says nothing at all.
      console.warn(
        '[restored-client-hosted-browser] no client host for restored pages; preparation answered',
        placement.kind,
        'for',
        environmentId
      )
    }
  } catch (error) {
    // Why swallowed: both callers ride paths a throw would take down with them -- hydration, which
    // would boot the app in degraded no-save mode, and the status update, which would lose unrelated
    // state. A page nobody hosts is recoverable; a lost session is not.
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
