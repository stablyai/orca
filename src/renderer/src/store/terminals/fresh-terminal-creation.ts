import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeTerminalWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { createWebRuntimeSessionTerminal } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { resolveTerminalWorktreeRoute } from '@/lib/workspace/ownership/terminal-worktree-route'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { insertUnifiedTabAfterAnchor } from '@/lib/workspace/tabs/unified-tab-anchor-insertion'
import { measureTerminalGroupGridSizes } from '@/runtime/sync-runtime-graph/terminal-group-grid-sizes'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { TabSplitTarget } from '../slices/tabs/tabs-slice-contract'
import type { CreateWebRuntimeSessionTerminalArgs } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'
import { resolveTerminalCreatedShell } from './terminal-created-shell'
import { getRemoteConnectionIdForWorktree } from './terminal-workspace-routing'
import {
  captureTerminalCreationNavigation,
  focusAcceptedTerminalPane
} from './terminal-creation-navigation'
import { projectRetainedTerminalStart, retainedStartFromRpcError } from './retained-terminal-start'

export type FreshTerminalCreation = Pick<
  CreateWebRuntimeSessionTerminalArgs,
  'command' | 'env' | 'envToDelete' | 'startupCommandDelivery' | 'viewMode' | 'afterTabId'
> & {
  worktreeId: string
  groupId?: string
  shell?: string
  cwd?: string
  split?: TabSplitTarget
  notifyFailure?: boolean
  selectWorktree?: boolean
}

/** Fresh user actions have no renderer destination until the host admits their launch. */
export async function createFreshTerminal(args: FreshTerminalCreation): Promise<boolean> {
  const { worktreeId } = args
  const state = useAppStore.getState()
  const route = resolveTerminalWorktreeRoute(state, worktreeId)
  if (!route) {
    return false
  }
  const groupId = args.groupId ?? state.activeGroupIdByWorktree[worktreeId]
  const grids = measureTerminalGroupGridSizes(state.settings?.terminalFontSize ?? 14)
  const sourceSize = grids?.groups[args.split?.sourceGroupId ?? groupId ?? '']
  const initialSize = sourceSize
    ? args.split
      ? args.split.splitDirection === 'left' || args.split.splitDirection === 'right'
        ? { cols: Math.max(1, Math.floor(sourceSize.cols / 2)), rows: sourceSize.rows }
        : { cols: sourceSize.cols, rows: Math.max(1, Math.floor(sourceSize.rows / 2)) }
      : sourceSize
    : grids?.singleGroupWorkspace
  if (route.runtimeEnvironmentId) {
    const outcome = await createWebRuntimeSessionTerminal(
      {
        ...args,
        environmentId: route.runtimeEnvironmentId,
        targetGroupId: groupId,
        split: args.split
          ? { besideGroupId: args.split.sourceGroupId, direction: args.split.splitDirection }
          : undefined,
        initialSize,
        activate: true,
        selectWorktree: args.selectWorktree ?? !args.split
      },
      { userAct: true, notifyFailure: args.notifyFailure }
    )
    return outcome.status === 'created' || outcome.status === 'retained'
  }
  if (isWebClientLocation() && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    return false
  }
  const { folder, createdShellOverride } = resolveTerminalCreatedShell(
    state,
    worktreeId,
    args.shell,
    undefined,
    undefined
  )
  // Direct SSH has its own supported IPC provider; it cannot run in the local runtime registry.
  if (folder?.connectionId || getRemoteConnectionIdForWorktree(state, worktreeId)) {
    const tab = state.createTab(worktreeId, groupId, args.shell, {
      ...(args.split ? { split: args.split } : {}),
      ...(args.cwd ? { startupCwd: args.cwd } : {}),
      ...(args.viewMode ? { viewMode: args.viewMode } : {}),
      ...(args.command !== undefined || args.env || args.envToDelete || args.startupCommandDelivery
        ? {
            pendingStartup: {
              command: args.command,
              env: args.env,
              envToDelete: args.envToDelete,
              startupCommandDelivery: args.startupCommandDelivery
            }
          }
        : {})
    })
    persistAgentLaunchTabOrder(worktreeId, tab.id)
    activateTabAndFocusPane(tab.id, null)
    focusTerminalTabSurface(tab.id)
    return true
  }
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  const targetGroupId = args.split ? createBrowserUuid() : groupId
  const navigation = captureTerminalCreationNavigation()
  try {
    const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
      { kind: 'local' },
      'terminal.create',
      {
        worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
        clientMutationId: createBrowserUuid(),
        tabId,
        leafId,
        targetGroupId,
        afterTabId: args.afterTabId,
        ...(args.split
          ? {
              split: {
                besideGroupId: args.split.sourceGroupId,
                direction: args.split.splitDirection
              }
            }
          : {}),
        initialSize,
        shell: createdShellOverride,
        cwd: args.cwd,
        command: args.command,
        env: args.env,
        envToDelete: args.envToDelete,
        startupCommandDelivery: args.startupCommandDelivery,
        viewMode: args.viewMode,
        presentation: 'background',
        focus: false,
        activate: false
      }
    )
    const acceptedPane = parsePaneKey(terminal.paneKey ?? '')
    if (
      terminal.tabId !== tabId ||
      acceptedPane?.tabId !== tabId ||
      acceptedPane.leafId !== leafId ||
      !terminal.ptyId
    ) {
      throw new Error('The host did not return the requested terminal session.')
    }
    const shouldFocus = navigation.current()
    navigation.dispose()
    const latest = useAppStore.getState()
    if (latest.closedTerminalTabTombstonesByTabId[tabId]?.worktreeId === worktreeId) {
      return true
    }
    const existing = latest.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
    if (!existing) {
      latest.createTab(worktreeId, targetGroupId, createdShellOverride, {
        id: tabId,
        initialLeafId: leafId,
        initialPtyId: terminal.ptyId,
        layoutAlreadyAdmitted: true,
        activate: false,
        ...(args.split &&
        !latest.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
          ? { split: { ...args.split, activate: false } }
          : {}),
        ...(args.cwd ? { startupCwd: args.cwd } : {}),
        ...(args.viewMode ? { viewMode: args.viewMode } : {})
      })
    } else {
      const layout = latest.terminalLayoutsByTabId[tabId]
      if (!layout?.root || !collectLayoutLeafIdsInOrder(layout.root).includes(leafId)) {
        return true
      }
      latest.updateTabPtyId(tabId, terminal.ptyId)
      latest.setTabLayout(tabId, {
        ...layout,
        ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: terminal.ptyId }
      })
    }
    persistAgentLaunchTabOrder(worktreeId, tabId)
    if (args.afterTabId) {
      const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
      const anchor = tabs.find(
        (tab) => tab.id === args.afterTabId || tab.entityId === args.afterTabId
      )
      const created = tabs.find((tab) => tab.entityId === tabId)
      if (anchor && created) {
        insertUnifiedTabAfterAnchor(worktreeId, created.id, anchor.id)
      }
    }
    if (shouldFocus) {
      focusAcceptedTerminalPane(tabId, leafId)
    }
    state.recordFeatureInteraction?.('terminal-tabs')
    return true
  } catch (error) {
    const retained = retainedStartFromRpcError(error)
    if (
      retained?.worktreeId === worktreeId &&
      retained.tabId === tabId &&
      retained.leafId === leafId &&
      retained.executionHostId === 'local' &&
      projectRetainedTerminalStart(retained, {
        groupId: targetGroupId,
        shell: createdShellOverride,
        cwd: args.cwd,
        viewMode: args.viewMode,
        split: args.split
      })
    ) {
      if (navigation.current()) {
        focusAcceptedTerminalPane(tabId, leafId)
      }
      return true
    }
    // An uncertain reply can still name a committed PTY; never try another create here.
    if (args.notifyFailure !== false) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
    return false
  } finally {
    navigation.dispose()
  }
}
