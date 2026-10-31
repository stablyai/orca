import type { AppState } from '../../../types'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  currentWorkspaceRemovalSources,
  workspaceRemovalTabIsCurrent,
  assertWorkspaceRemovalScopeCurrent,
  type WorkspaceRemovalScope
} from './workspace-removal-scope'
import { retireStructuredAgentSessionTab } from '@/runtime/structured-agent-session-tab-retirement'
import {
  structuredAgentSessionTargetForTab,
  structuredAgentSessionFocusOwner
} from '@/runtime/structured-agent-session-owner'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'
import { retireLocalSourceAddress } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { retireWebSessionTabsSourceAddress } from '@/runtime/web-session-tabs-sync/source-address-retirement'
import { buildHostTwinPurgeState, workspacePublishingHosts } from './host-twin-worktree-purge'
import {
  rawWorkspaceState,
  workspacePresentationFor,
  workspaceSourceWrite,
  noteWorkspacePresentationChanges
} from '../../../workspace-source-state'
import { workspacePresentationKey } from '../../../../../../shared/workspace-presentation'
import { editWorkspacePresentationDocuments } from '../../../../../../shared/workspace-presentation-documents'
import { destroyWorkspaceWebviews } from '../../browser-webview-cleanup'
import {
  captureWorkspaceChatDraftKeys,
  deleteWorkspaceChatDrafts
} from './removed-worktree-chat-drafts'
import { flushRemovalPendingEdits } from '@/components/editor/removal-unsaved-editor-files'
import type { ConfirmedUnsavedDiscards } from './removed-workspace-unsaved-files'
import { mergeEditorBufferKeepRequests } from '../../editor/buffers/editor-buffer-kept'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '../../../../components/terminal-pane/terminal-parked-watcher-registry'
import { forgetDesktopCreatedServerTabsOf } from '@/lib/desktop-created-server-tabs'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-message-sender'
import { retireRemovedNativeChatDraftPositions } from '@/components/native-chat/native-chat-draft-cache'

/** The backend's native sweep is literal; retire admitted sibling sources using their issued handles. */
export async function closeWorkspaceRemovalNativeSources(
  get: WorktreeSliceGet,
  scope: WorkspaceRemovalScope,
  allowUnverified: boolean
): Promise<void> {
  for (const entry of currentWorkspaceRemovalSources(get(), scope)) {
    if (entry.source.workspaceId === scope.target.id) {
      continue
    }
    for (const tab of entry.tabs.filter((tab) => tab.contentType === 'agent-session')) {
      const target = structuredAgentSessionTargetForTab(get(), tab)
      const owner =
        target &&
        captureWebSessionIntentOwner(structuredAgentSessionFocusOwner(target).environmentId)
      const current = () => {
        assertWorkspaceRemovalScopeCurrent(get(), scope)
        if (
          !workspaceRemovalTabIsCurrent(get(), scope, tab) ||
          (owner && !matchesWebSessionIntentOwner(owner)) ||
          JSON.stringify(structuredAgentSessionTargetForTab(get(), tab)) !== JSON.stringify(target)
        ) {
          throw new Error('The session owner changed during removal. Try again.')
        }
      }
      current()
      if (!target) {
        if (allowUnverified) {
          continue
        }
        throw new Error('Could not identify the workspace agent session owner. Try again.')
      }
      let failure: unknown
      const closed = await retireStructuredAgentSessionTab({
        target,
        worktreeId: tab.worktreeId,
        sessionId: tab.entityId,
        beforeSend: current,
        onError: (error) => {
          failure = error
        }
      })
      if ((!closed || failure) && !allowUnverified) {
        throw (
          failure ??
          new Error('Could not confirm that the workspace agent session closed. Try again.')
        )
      }
    }
  }
}

/** Resource cleanup uses the accepted captured scope; target metadata is handled separately. */
export async function tearDownWorkspaceRemovalResources(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  scope: WorkspaceRemovalScope,
  confirmedDiscards?: ConfirmedUnsavedDiscards
): Promise<void> {
  assertWorkspaceRemovalScopeCurrent(get(), scope)
  for (const entry of currentWorkspaceRemovalSources(get(), scope)) {
    const id = entry.source.workspaceId
    const host = entry.source.hostId
    // Advance the real source fence before owner callbacks or ordered failed-close readbacks can publish.
    if (host === 'local' || host.startsWith('ssh:')) {
      retireLocalSourceAddress(id)
    } else if (host.startsWith('runtime:')) {
      retireWebSessionTabsSourceAddress(host.slice('runtime:'.length), id)
    }
    for (const browser of entry.browsers) {
      assertWorkspaceRemovalScopeCurrent(get(), scope)
      const pages = get().browserPagesByWorkspace
      const closed = await new Promise<boolean>((resolve) =>
        get().closeBrowserTab(browser.id, {
          preserveWorktreeSelection: true,
          admitClose: () =>
            currentWorkspaceRemovalSources(get(), scope).some((current) =>
              current.browsers.some((row) => row.id === browser.id)
            ),
          onSettled: resolve
        })
      )
      if (closed) {
        destroyWorkspaceWebviews(pages, browser.id)
      }
    }
    const refreshed = currentWorkspaceRemovalSources(get(), scope).find(
      (current) => current.source.workspaceId === id
    )
    if (!refreshed) {
      continue
    }
    const terminalIds = refreshed.removed.terminalTabIds
    await get().shutdownWorktreeTerminals(id, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true,
      onlyTabIds: terminalIds,
      canCommit: () =>
        currentWorkspaceRemovalSources(get(), scope).some(
          (current) =>
            current.source.workspaceId === id &&
            [...terminalIds].every((tabId) => current.removed.terminalTabIds.has(tabId))
        )
    })
    assertWorkspaceRemovalScopeCurrent(get(), scope)
    const current = currentWorkspaceRemovalSources(get(), scope).find(
      (current) => current.source.workspaceId === id
    )
    if (!current) {
      continue
    }
    const survivors = workspacePublishingHosts(get(), id).filter(
      (owner) => owner !== scope.target.hostId && owner !== current.source.executionHostId
    )
    const raw = rawWorkspaceState(get())
    forgetForegroundTerminalTabs(current.removed.terminalTabIds)
    forgetAgentStartupDeliveriesForTabs(current.removed.terminalTabIds)
    for (const tab of current.tabs) {
      if (tab.contentType === 'agent-session') {
        stopStructuredAgentSessionSends(tab.entityId)
      }
    }
    retireRemovedNativeChatDraftPositions(current.tabs, [])
    const unremoved =
      (raw.unifiedTabsByWorktree[id] ?? []).some(
        (tab) => !current.tabs.some((old) => old.id === tab.id)
      ) ||
      (raw.browserTabsByWorktree[id] ?? []).some(
        (tab) => !current.removed.browserTabIds.has(tab.id)
      )
    const drafts = captureWorkspaceChatDraftKeys(
      {
        tabsByWorktree: { [id]: current.terminals },
        unifiedTabsByWorktree: { [id]: current.tabs }
      },
      [
        {
          workspaceId: id,
          executionHostId: current.source.executionHostId ?? host,
          onlyEntityIds: new Set([...current.removed.conversationIds, ...terminalIds])
        }
      ]
    )
    deleteWorkspaceChatDrafts({
      ...drafts,
      owners: survivors.length || unremoved ? [] : drafts.owners
    })
    disposeRemovedWorktreeParkedTerminalWatchers(
      id,
      current.terminals.flatMap((tab) => [
        ...(tab.ptyId ? [tab.ptyId] : []),
        ...(raw.ptyIdsByTabId[tab.id] ?? [])
      ])
    )
    if (!survivors.length && !unremoved) {
      forgetDesktopCreatedServerTabsOf(id)
      await get().deleteManagedBrowserSessionProfile({ kind: 'worktree', id })
    }
  }
  assertWorkspaceRemovalScopeCurrent(get(), scope)
  const sources = currentWorkspaceRemovalSources(get(), scope)
  flushRemovalPendingEdits(
    get(),
    sources.flatMap(({ removed }) => [...removed.fileIds])
  )
  set((state) => {
    assertWorkspaceRemovalScopeCurrent(state, scope)
    let patch: Partial<AppState> = {}
    for (const entry of currentWorkspaceRemovalSources(state, scope)) {
      const id = entry.source.workspaceId
      const host = entry.source.executionHostId ?? entry.source.hostId
      const next = { ...state, ...patch }
      const survivors = workspacePublishingHosts(next, id).filter(
        (owner) => owner !== host && owner !== entry.source.hostId
      )
      const tabIds = new Set(entry.tabs.map((tab) => tab.id))
      const wholeSource =
        !survivors.length &&
        !(next.unifiedTabsByWorktree[id] ?? []).some((tab) => !tabIds.has(tab.id)) &&
        !(next.tabsByWorktree[id] ?? []).some((tab) => !entry.removed.terminalTabIds.has(tab.id)) &&
        !(next.browserTabsByWorktree[id] ?? []).some(
          (tab) => !entry.removed.browserTabIds.has(tab.id)
        ) &&
        !next.openFiles.some(
          (file) => file.worktreeId === id && !entry.removed.fileIds.has(file.id)
        )
      const resourcePatch = buildHostTwinPurgeState(
        next,
        host,
        new Map([
          [
            id,
            workspacePublishingHosts(next, id).filter(
              (owner) => owner !== host && owner !== entry.source.hostId
            )
          ]
        ]),
        undefined,
        { removed: entry.removed, confirmedDiscards, wholeSource }
      )
      patch = {
        ...patch,
        ...resourcePatch,
        editorBufferKeepRequest: mergeEditorBufferKeepRequests(
          patch.editorBufferKeepRequest,
          resourcePatch.editorBufferKeepRequest
        )
      }
    }
    let documents = state.workspacePresentations
    const saved = workspacePresentationFor(state, scope.target.id)
    const changed: string[] = []
    if (
      saved &&
      (saved.anchor.hostId === scope.target.hostId ||
        saved.anchor.executionHostId === scope.target.hostId)
    ) {
      const next = { ...state, ...patch }
      const remaining = saved.baseline.some(({ source }) =>
        (next.unifiedTabsByWorktree[source.workspaceId] ?? []).some(
          (tab) =>
            !tab.executionHostId ||
            tab.executionHostId === source.hostId ||
            tab.executionHostId === source.executionHostId
        )
      )
      if (!remaining) {
        const key = workspacePresentationKey(saved.owner, saved.anchor)
        documents = editWorkspacePresentationDocuments(documents ?? {}, key, undefined)
        changed.push(key)
      }
    }
    if (documents && changed.length) {
      noteWorkspacePresentationChanges(documents, changed)
    }
    return workspaceSourceWrite(
      { ...patch, workspacePresentations: documents },
      { sources: sources.map(({ source }) => source.workspaceId), documents: changed }
    )
  })
}
