import {
  registerEagerPtyBuffer,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { retireUnownedTerminal } from '@/lib/retire-unowned-background-terminal'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { buildSetupRunnerCommand } from '../../../shared/setup-runner-command'
import type {
  TerminalLayoutSnapshot,
  Worktree,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/types'

type BackgroundPane = {
  leafId: string
  ptyId: string
}

type BackgroundTab = {
  tabId: string
  primary: BackgroundPane
}

type BackgroundTerminalLaunch = {
  command?: string
  env?: Record<string, string>
  title?: string
  color?: string
}

function getSetupTabTitle(): string {
  return translate('auto.lib.launch.worktree.background.terminals.setupTitle', 'Setup')
}

export type LaunchWorktreeBackgroundTerminalsArgs = {
  worktreeId: string
  setup?: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
}

function buildPaneEnv(
  worktreeId: string,
  tabId: string,
  leafId: string,
  env: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...env,
    ORCA_PANE_KEY: makePaneKey(tabId, leafId),
    ORCA_TAB_ID: tabId,
    ORCA_WORKTREE_ID: worktreeId
  }
}

function buildSplitLayout(
  first: BackgroundPane,
  second: BackgroundPane,
  direction: 'horizontal' | 'vertical',
  secondTitle: string
): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction,
      first: { type: 'leaf', leafId: first.leafId },
      second: { type: 'leaf', leafId: second.leafId }
    },
    activeLeafId: first.leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [first.leafId]: first.ptyId,
      [second.leafId]: second.ptyId
    },
    titlesByLeafId: {
      [second.leafId]: secondTitle
    }
  }
}

function persistExitedPaneOutput(tabId: string, leafId: string, output: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  const { ptyIdsByLeafId: existingPtyIds, buffersByLeafId: existingBuffers, ...rest } = layout
  const nextPtyIds = { ...existingPtyIds }
  delete nextPtyIds[leafId]
  const trimmedOutput = output.trim() ? output : ''
  store.setTabLayout(tabId, {
    ...rest,
    ...(Object.keys(nextPtyIds).length > 0 ? { ptyIdsByLeafId: nextPtyIds } : {}),
    ...(trimmedOutput
      ? {
          buffersByLeafId: {
            ...existingBuffers,
            [leafId]: output
          }
        }
      : existingBuffers
        ? { buffersByLeafId: existingBuffers }
        : {})
  })
}

function registerBackgroundPaneBuffer(tabId: string, leafId: string, ptyId: string): void {
  let eagerBuffer: EagerPtyHandle | null = null
  eagerBuffer = registerEagerPtyBuffer(ptyId, (exitPtyId) => {
    persistExitedPaneOutput(tabId, leafId, eagerBuffer?.flush() ?? '')
    useAppStore.getState().clearTabPtyId(tabId, exitPtyId)
  })
}

function buildSetupCommand(setup: WorktreeSetupLaunch): string {
  return buildSetupRunnerCommand(
    setup.runnerScriptPath,
    isWindowsAbsolutePathLike(setup.runnerScriptPath) ? 'windows' : 'posix'
  )
}

async function spawnPane(args: {
  worktree: Worktree
  connectionId: string | null
  tabId: string
  leafId: string
  command?: string
  env?: Record<string, string>
}): Promise<string> {
  const result = await window.api.pty.spawn({
    cols: 120,
    rows: 40,
    cwd: args.worktree.path,
    ...(args.command ? { command: args.command } : {}),
    env: buildPaneEnv(args.worktree.id, args.tabId, args.leafId, args.env),
    connectionId: args.connectionId,
    worktreeId: args.worktree.id,
    tabId: args.tabId,
    leafId: args.leafId
  })
  return result.id
}

async function createBackgroundTab(args: {
  worktree: Worktree
  connectionId: string | null
  launch: BackgroundTerminalLaunch
}): Promise<BackgroundTab> {
  const store = useAppStore.getState()
  const tab = store.createTab(args.worktree.id, undefined, undefined, {
    activate: false,
    recordInteraction: false
  })
  if (args.launch.title) {
    store.setTabCustomTitle(tab.id, args.launch.title, { recordInteraction: false })
  }
  if (args.launch.color) {
    store.setTabColor(tab.id, args.launch.color)
  }

  const leafId = createBrowserUuid()
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))
  let ptyId: string
  try {
    ptyId = await spawnPane({
      worktree: args.worktree,
      connectionId: args.connectionId,
      tabId: tab.id,
      leafId,
      command: args.launch.command,
      env: args.launch.env
    })
  } catch (error) {
    store.closeTab(tab.id, { recordInteraction: false })
    throw error
  }
  if (
    await retireUnownedTerminal({
      tabId: tab.id,
      ptyId,
      runtimeTarget: { kind: 'local' }
    })
  ) {
    throw new Error('The terminal tab was closed before its session finished starting.')
  }
  store.updateTabPtyId(tab.id, ptyId)
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId))
  registerBackgroundPaneBuffer(tab.id, leafId, ptyId)
  return { tabId: tab.id, primary: { leafId, ptyId } }
}

async function addSetupSplit(args: {
  worktree: Worktree
  connectionId: string | null
  tab: BackgroundTab
  setup: WorktreeSetupLaunch
  direction: 'horizontal' | 'vertical'
}): Promise<void> {
  const store = useAppStore.getState()
  const setupLeafId = createBrowserUuid()
  const setupPtyId = await spawnPane({
    worktree: args.worktree,
    connectionId: args.connectionId,
    tabId: args.tab.tabId,
    leafId: setupLeafId,
    command: buildSetupCommand(args.setup),
    env: args.setup.envVars
  })
  if (
    await retireUnownedTerminal({
      tabId: args.tab.tabId,
      ptyId: setupPtyId,
      runtimeTarget: { kind: 'local' }
    })
  ) {
    return
  }
  store.updateTabPtyId(args.tab.tabId, setupPtyId)
  store.setTabLayout(
    args.tab.tabId,
    buildSplitLayout(
      args.tab.primary,
      { leafId: setupLeafId, ptyId: setupPtyId },
      args.direction,
      getSetupTabTitle()
    )
  )
  registerBackgroundPaneBuffer(args.tab.tabId, setupLeafId, setupPtyId)
}

function getDefaultTabLaunches(
  defaultTabs: WorktreeDefaultTabsLaunch | undefined
): BackgroundTerminalLaunch[] {
  return (defaultTabs?.tabs ?? []).map((tab) => {
    const command = tab.command?.trim()
    return {
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.color ? { color: tab.color } : {}),
      ...(command && defaultTabs?.runCommands ? { command } : {})
    }
  })
}

export async function launchWorktreeBackgroundTerminals(
  args: LaunchWorktreeBackgroundTerminalsArgs
): Promise<void> {
  if (!args.setup && !args.defaultTabs) {
    return
  }
  const store = useAppStore.getState()
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, args.worktreeId)
  )
  if (runtimeTarget.kind === 'environment') {
    // Runtime-owned worktrees materialize setup/defaultTabs inside createManagedWorktree.
    return
  }

  const worktree = store.allWorktrees().find((entry) => entry.id === args.worktreeId)
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const repo = store.repos.find((entry) => entry.id === worktree.repoId)
  const connectionId = repo?.connectionId ?? null
  const defaultLaunches = getDefaultTabLaunches(args.defaultTabs)
  const launchedTabs: BackgroundTab[] = []

  for (const launch of defaultLaunches) {
    try {
      launchedTabs.push(await createBackgroundTab({ worktree, connectionId, launch }))
    } catch (error) {
      console.warn('[automations] Failed to launch workspace default tab:', error)
    }
  }

  const setupMode = store.settings?.setupScriptLaunchMode ?? 'new-tab'
  const shouldSplitSetup =
    args.setup && (setupMode === 'split-horizontal' || setupMode === 'split-vertical')
  if (shouldSplitSetup) {
    const primaryTab =
      launchedTabs[0] ?? (await createBackgroundTab({ worktree, connectionId, launch: {} }))
    await addSetupSplit({
      worktree,
      connectionId,
      tab: primaryTab,
      setup: args.setup!,
      direction: setupMode === 'split-horizontal' ? 'horizontal' : 'vertical'
    })
    return
  }

  if (args.setup) {
    if (launchedTabs.length === 0) {
      launchedTabs.push(await createBackgroundTab({ worktree, connectionId, launch: {} }))
    }
    await createBackgroundTab({
      worktree,
      connectionId,
      launch: {
        title: getSetupTabTitle(),
        command: buildSetupCommand(args.setup),
        env: args.setup.envVars
      }
    })
  }
}
