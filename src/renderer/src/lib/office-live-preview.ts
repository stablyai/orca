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
import type { OfficeDocumentLocation } from '@/lib/office-preview-plan'
import { officeHostOwnerKey, type OfficeHostOwner } from '../../../shared/office-host-owner'
import type { OfficeErrorCode } from '../../../shared/office-preview-contracts'

type LiveSession = {
  worktreeId: string
  /** Browser workspace row the live page lives in; when it goes, so does the watch. */
  workspaceId: string
  /**
   * Page the live URL was converted into. A conversion always mints a fresh page id, so this id
   * disappearing is the signal that the reader left the live page — including by going Back to the
   * document, which leaves the workspace row intact and would otherwise strand the watch process.
   */
  livePageId: string
  owner: OfficeHostOwner
  document: OfficeDocumentLocation
  /** Pushes external edits into the running server; the pane that started it is already gone. */
  refresh: { dispose: () => void }
}

const sessionsByKey = new Map<string, LiveSession>()

function sessionKey(owner: OfficeHostOwner, document: OfficeDocumentLocation): string {
  return JSON.stringify([officeHostOwnerKey(owner), document.workspaceRoot, document.relativePath])
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
  document: OfficeDocumentLocation
  /** Set for a paired workspace, so the converted page's guest runs on the runtime host. */
  browserRuntimeEnvironmentId: string | null
}): Promise<OfficeLiveStart> {
  const outcome = await window.api.office.watchStart({
    owner: params.owner,
    ...params.document
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
    await window.api.office.watchStop({ owner: params.owner, ...params.document })
    return { ok: false, code: 'OFFICECLI_WATCH_FAILED' }
  }
  const livePageId = findLivePageId(params.workspaceId, url)
  if (!livePageId) {
    // The conversion reported success but no page carries the URL, so nothing would ever sweep
    // this watch. Stop it now rather than leak a process with no surface.
    await window.api.office.watchStop({ owner: params.owner, ...params.document })
    return { ok: false, code: 'OFFICECLI_WATCH_FAILED' }
  }
  sessionsByKey.set(sessionKey(params.owner, params.document), {
    worktreeId: params.worktreeId,
    workspaceId: params.workspaceId,
    livePageId,
    owner: params.owner,
    document: params.document,
    refresh: subscribeOfficeLiveRefresh({
      owner: params.owner,
      document: params.document,
      worktreeId: params.worktreeId,
      worktreePath: useAppStore.getState().getKnownWorktreeById(params.worktreeId)?.path ?? null
    })
  })
  return { ok: true, url }
}

export async function stopOfficeLivePreview(
  owner: OfficeHostOwner,
  document: OfficeDocumentLocation
): Promise<void> {
  const key = sessionKey(owner, document)
  sessionsByKey.get(key)?.refresh.dispose()
  sessionsByKey.delete(key)
  await window.api.office.watchStop({ owner, ...document }).catch(() => undefined)
}

/** Pushes a re-render through the running watch server, which tells connected pages to reload. */
export async function refreshOfficeLivePreview(
  owner: OfficeHostOwner,
  document: OfficeDocumentLocation
): Promise<boolean> {
  const outcome = await window.api.office
    .watchRefresh({ owner, ...document })
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

/** The page a converted live URL landed on, so the sweep can notice when the reader leaves it. */
function findLivePageId(workspaceId: string, url: string): string | null {
  const pages = useAppStore.getState().browserPagesByWorkspace[workspaceId] ?? []
  return pages.find((page) => page.url === url)?.id ?? null
}

/**
 * Stops every live session whose page is gone.
 *
 * A watch process outlives its page by design — it is detached — so something has to notice. The
 * signal is the live page's own id: a conversion always mints a fresh page, so going Back to the
 * document retires the live id even though the browser workspace row survives. Keying on the row
 * alone would leave the watch running with nothing showing it until the whole tab closed.
 *
 * Driven off the store rather than a component's unmount, in the `closed-editor-tab-*` sweep
 * shape, because the component is gone by the time it matters.
 */
export function sweepClosedOfficeLivePreviews(): void {
  if (sessionsByKey.size === 0) {
    return
  }
  const state = useAppStore.getState()
  const closed: [string, LiveSession][] = []
  for (const entry of sessionsByKey) {
    const session = entry[1]
    const stillLive = (state.browserPagesByWorkspace[session.workspaceId] ?? []).some(
      (page) => page.id === session.livePageId
    )
    if (!stillLive) {
      closed.push(entry)
    }
  }
  for (const [key, session] of closed) {
    session.refresh.dispose()
    sessionsByKey.delete(key)
    void window.api.office
      .watchStop({ owner: session.owner, ...session.document })
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
