/**
 * Turning a document preview into a live one, and making sure the watch process dies with it.
 *
 * The live page is not new transport. `officecli watch` serves ordinary HTTP on the owning host's
 * loopback, and Orca already has a browser page that reaches exactly that:
 *
 *  - a local workspace loads `http://127.0.0.1:<port>` directly;
 *  - an SSH workspace's pages mount on a proxy-verified partition that routes through the SSH
 *    target (`browser:prepareSshWorkspacePartition`), so the same URL resolves on the remote host;
 *  - a paired workspace's page is bound to its runtime environment, so its guest runs on the
 *    machine the watch server is on.
 *
 * So "go live" is a page conversion — the same door the address bar uses — and Back crosses back
 * to the document because conversion already records that leg.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { subscribeOfficeLiveRefresh } from '@/lib/office-live-refresh'
import { officeHostOwnerKey, type OfficeHostOwner } from '../../../shared/office-host-owner'
import type { OfficeErrorCode } from '../../../shared/office-preview-contracts'

type LiveSession = {
  worktreeId: string
  /** Browser workspace row the live page lives in; when it goes, so does the watch. */
  workspaceId: string
  owner: OfficeHostOwner
  filePath: string
  /** Pushes external edits into the running server; the pane that started it is already gone. */
  refresh: { dispose: () => void }
}

const sessionsByKey = new Map<string, LiveSession>()

function sessionKey(owner: OfficeHostOwner, filePath: string): string {
  return `${officeHostOwnerKey(owner)} ${filePath}`
}

export type OfficeLiveStart =
  | { ok: true; url: string }
  | { ok: false; code: OfficeErrorCode; detail?: string }

/**
 * Starts a watch on the owning host and converts the preview page to its URL.
 *
 * Failure is silent to the point of being recoverable: the caller keeps showing the snapshot, so
 * nothing is lost — the toggle just reports why it could not go live.
 */
export async function startOfficeLivePreview(params: {
  pageId: string
  workspaceId: string
  worktreeId: string
  owner: OfficeHostOwner
  filePath: string
  /** Set for a paired workspace, so the converted page's guest runs on the runtime host. */
  browserRuntimeEnvironmentId: string | null
}): Promise<OfficeLiveStart> {
  const outcome = await window.api.office.watchStart({
    owner: params.owner,
    path: params.filePath
  })
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      ...(outcome.detail ? { detail: outcome.detail } : {})
    }
  }
  const url = `http://127.0.0.1:${outcome.port}/`
  const converted = useAppStore.getState().convertBrowserPage(params.pageId, {
    kind: 'web',
    url,
    browserRuntimeEnvironmentId: params.browserRuntimeEnvironmentId
  })
  if (!converted) {
    // Nothing to show it in, so nothing should be running for it either.
    await window.api.office.watchStop({ owner: params.owner, path: params.filePath })
    return { ok: false, code: 'OFFICECLI_WATCH_FAILED' }
  }
  sessionsByKey.set(sessionKey(params.owner, params.filePath), {
    worktreeId: params.worktreeId,
    workspaceId: params.workspaceId,
    owner: params.owner,
    filePath: params.filePath,
    refresh: subscribeOfficeLiveRefresh({
      owner: params.owner,
      filePath: params.filePath,
      worktreeId: params.worktreeId,
      worktreePath: useAppStore.getState().getKnownWorktreeById(params.worktreeId)?.path ?? null
    })
  })
  return { ok: true, url }
}

export async function stopOfficeLivePreview(
  owner: OfficeHostOwner,
  filePath: string
): Promise<void> {
  const key = sessionKey(owner, filePath)
  sessionsByKey.get(key)?.refresh.dispose()
  sessionsByKey.delete(key)
  await window.api.office.watchStop({ owner, path: filePath }).catch(() => undefined)
}

/** Pushes a re-render through the running watch server, which tells connected pages to reload. */
export async function refreshOfficeLivePreview(
  owner: OfficeHostOwner,
  filePath: string
): Promise<boolean> {
  const outcome = await window.api.office
    .watchRefresh({ owner, path: filePath })
    .catch(() => ({ ok: false as const, code: 'OFFICE_HOST_UNREACHABLE' as const }))
  if (!outcome.ok) {
    toast.error(
      translate(
        'auto.lib.office.live.refreshFailed',
        'The live preview did not refresh. It is still showing the previous version.'
      )
    )
  }
  return outcome.ok
}

/**
 * Stops every live session whose browser workspace no longer exists.
 *
 * A watch process outlives its page by design — it is detached — so closing a tab has to be
 * noticed by something. This is the `closed-editor-tab-*` sweep shape: driven off the store rather
 * than off a component's unmount, because the component is gone by the time it matters.
 */
export function sweepClosedOfficeLivePreviews(): void {
  if (sessionsByKey.size === 0) {
    return
  }
  const state = useAppStore.getState()
  const closed: [string, LiveSession][] = []
  for (const entry of sessionsByKey) {
    const stillOpen = (state.browserTabsByWorktree[entry[1].worktreeId] ?? []).some(
      (tab) => tab.id === entry[1].workspaceId
    )
    if (!stillOpen) {
      closed.push(entry)
    }
  }
  for (const [key, session] of closed) {
    session.refresh.dispose()
    sessionsByKey.delete(key)
    void window.api.office
      .watchStop({ owner: session.owner, path: session.filePath })
      .catch(() => undefined)
  }
}

export function installOfficeLivePreviewSweep(): () => void {
  return useAppStore.subscribe(sweepClosedOfficeLivePreviews)
}

/** Test seam: the registry is module state, and a leaked entry would sweep a later test's tab. */
export function _resetOfficeLivePreviewsForTests(): void {
  for (const session of sessionsByKey.values()) {
    session.refresh.dispose()
  }
  sessionsByKey.clear()
}
