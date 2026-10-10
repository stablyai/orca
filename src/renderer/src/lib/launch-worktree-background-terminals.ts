import { createBrowserUuid } from '@/lib/browser-uuid'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { retireUnownedTerminal } from '@/lib/retire-unowned-background-terminal'
import { registerBackgroundPaneBuffer } from '@/lib/background-pane-exit-output'
import { terminalPanePlacementRow } from '@/lib/terminal-pane-placement-row'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../shared/setup-runner-command'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import type { Worktree } from '../../../shared/worktree/types'

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

function buildSplitRoot(
  firstLeafId: string,
  secondLeafId: string,
  direction: 'horizontal' | 'vertical'
): TerminalPaneLayoutNode {
  return {
    type: 'split',
    direction,
    first: { type: 'leaf', leafId: firstLeafId },
    second: { type: 'leaf', leafId: secondLeafId }
  }
}

function buildSplitLayout(
  first: BackgroundPane,
  second: BackgroundPane,
  direction: 'horizontal' | 'vertical',
  secondTitle: string
): TerminalLayoutSnapshot {
  return {
    root: buildSplitRoot(first.leafId, second.leafId, direction),
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

function buildSetupCommand(setup: WorktreeSetupLaunch): string {
  // Why: background setup tabs can launch later, so they must reuse the same shell chosen when the runner was written.
  return buildSetupRunnerCommand(
    setup.runnerScriptPath,
    getSetupRunnerCommandPlatformForPath(setup.runnerScriptPath, 'posix'),
    setup.shell
  )
}

/** The id a background pane got, plus which lifetime of it this spawn owns. */
type SpawnedPane = { ptyId: string; incarnationId?: string }

async function spawnPane(args: {
  worktree: Worktree
  connectionId: string | null
  tabId: string
  leafId: string
  placement: TerminalPanePlacement
  command?: string
  env?: Record<string, string>
}): Promise<SpawnedPane> {
  const result = await window.api.pty.spawn({
    cols: 120,
    rows: 40,
    cwd: args.worktree.path,
    ...(args.command ? { command: args.command } : {}),
    env: buildPaneEnv(args.worktree.id, args.tabId, args.leafId, args.env),
    connectionId: args.connectionId,
    worktreeId: args.worktree.id,
    tabId: args.tabId,
    leafId: args.leafId,
    placement: args.placement
  })
  return {
    ptyId: result.id,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
  }
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
  const created =
    useAppStore.getState().tabsByWorktree[args.worktree.id]?.find(({ id }) => id === tab.id) ?? tab
  let pane: SpawnedPane
  try {
    pane = await spawnPane({
      worktree: args.worktree,
      connectionId: args.connectionId,
      tabId: tab.id,
      leafId,
      placement: { kind: 'new-tab', row: terminalPanePlacementRow(created) },
      command: args.launch.command,
      env: args.launch.env
    })
  } catch (error) {
    store.closeTab(tab.id, { recordInteraction: false, reason: 'cleanup' })
    throw error
  }
  if (
    await retireUnownedTerminal({
      owner: { tabId: tab.id },
      ptyId: pane.ptyId,
      runtimeTarget: { kind: 'local' }
    })
  ) {
    throw new Error('The terminal tab was closed before its session finished starting.')
  }
  store.updateTabPtyId(tab.id, pane.ptyId)
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, pane.ptyId))
  registerBackgroundPaneBuffer(tab.id, leafId, pane)
  return { tabId: tab.id, primary: { leafId, ptyId: pane.ptyId } }
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
  const setupPane = await spawnPane({
    worktree: args.worktree,
    connectionId: args.connectionId,
    tabId: args.tab.tabId,
    leafId: setupLeafId,
    placement: {
      kind: 'split',
      parentLeafId: args.tab.primary.leafId,
      direction: args.direction,
      proposedRoot: buildSplitRoot(args.tab.primary.leafId, setupLeafId, args.direction)
    },
    command: buildSetupCommand(args.setup),
    env: args.setup.envVars
  })
  if (
    await retireUnownedTerminal({
      owner: { tabId: args.tab.tabId },
      ptyId: setupPane.ptyId,
      runtimeTarget: { kind: 'local' }
    })
  ) {
    return
  }
  store.updateTabPtyId(args.tab.tabId, setupPane.ptyId)
  store.setTabLayout(
    args.tab.tabId,
    buildSplitLayout(
      args.tab.primary,
      { leafId: setupLeafId, ptyId: setupPane.ptyId },
      args.direction,
      getSetupTabTitle()
    )
  )
  registerBackgroundPaneBuffer(args.tab.tabId, setupLeafId, setupPane)
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
  const runtimeTarget = runtimeTargetForOwnerEnvironment(
    getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
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
