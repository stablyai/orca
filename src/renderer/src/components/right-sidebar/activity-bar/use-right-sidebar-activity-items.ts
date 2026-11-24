import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import {
  builtInTabNames,
  getPluginPanelActivityItems,
  withDistinctPluginPanelNames
} from '../plugin-panels/plugin-panel-activity-items'
import { getDefaultRightSidebarActivityItems } from './right-sidebar-default-activity-items'
import {
  getPortsPanelOwnerKey,
  portsPanelHostForOwnerKey,
  portsPanelReachesRemoteHost
} from '../ports/ports-panel-host'
import {
  collectInstalledPluginTabKeys,
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelsFetchStatus
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { getActiveChecksStatus } from '../checks-panel/status/active-checks-status'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { ActivityBarItem } from './activity-bar-buttons'
import { useBotForWorkspace, useBotGroupForWorkspace } from '../../bots/bot-workspace'
import { useFocusedChatWorkers } from '@/lib/focused-chat-workers'
import { useBotNeedsYouCount, useBotNow } from '../../bots/use-bot-now'
import { usePublishedBotsNeedsYou } from '../../bots/bot-needs-you-published'
import { useBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import { botGroupMemberBots } from '../../../../../shared/bots/bot-sidebar-entries'

const NO_BOTS: readonly Bot[] = []

function useGroupMembers(group: BotGroup | null): readonly Bot[] {
  const bots = useBots(group !== null)
  return useMemo(() => (group ? botGroupMemberBots(group, bots) : NO_BOTS), [group, bots])
}

export type RightSidebarActivityItems = {
  visibleItems: ActivityBarItem[]
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
  isBotPage: boolean
}

export function useRightSidebarActivityItems({
  rightSidebarOpen
}: {
  rightSidebarOpen: boolean
}): RightSidebarActivityItems {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const explorerShortcut = useShortcutLabel('sidebar.explorer.toggle')
  const sourceControlShortcut = useShortcutLabel('sidebar.sourceControl.toggle')
  const checksShortcut = useShortcutLabel('sidebar.checks.toggle')
  const portsShortcut = useShortcutLabel('sidebar.ports.toggle')
  const agentsShortcut = useShortcutLabel('sidebar.agents.toggle')
  const activeWorktreeId = useAppStore((s) => (rightSidebarOpen ? s.activeWorktreeId : null))
  // Hide Git-only tabs for folder workspaces.
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeWorkspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const isFolderWorkspace = activeWorkspaceScope?.type === 'folder'
  const isFolder = isFolderWorkspace || (activeRepo ? isFolderRepo(activeRepo) : false)
  const bot = useBotForWorkspace(isFolderWorkspace ? activeWorktreeId : null)
  const isBot = bot !== null
  const group = useBotGroupForWorkspace(isFolderWorkspace ? activeWorktreeId : null)
  const isGroupHome = group !== null
  const groupMembers = useGroupMembers(group)
  const now = useBotNow(bot)
  const { needs } = now
  // A bot's first tab is Home: its badge counts Orca's asks and items in Needs you. A group's counts
  // its members' as their own tabs do, published by its open panel.
  const botNeedsYou = useBotNeedsYouCount(bot, now)
  const groupNeedsYou = usePublishedBotsNeedsYou(groupMembers)
  const needsYou = isGroupHome ? groupNeedsYou : botNeedsYou
  const showsHomeTab = isBot || isGroupHome
  // The same read as Activity's count, so connector reads aren't repeated for the tab.
  const connectorsNeedingOwner = needs.filter((need) => need.kind === 'connector').length
  const hasChatWorkers = useFocusedChatWorkers(rightSidebarOpen && !isBot).workers.length > 0
  // Why the owner: a managed server's workspace names its server, not an SSH connection.
  const hasRemoteHost = useAppStore((s) =>
    portsPanelReachesRemoteHost(
      portsPanelHostForOwnerKey(getPortsPanelOwnerKey(s, activeWorktreeId))
    )
  )
  const pluginSystemEnabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const pluginPanels = usePluginPanels()
  const visiblePluginPanels = useMemo(
    () => (pluginSystemEnabled ? pluginPanels : []),
    [pluginPanels, pluginSystemEnabled]
  )
  const installedPlugins = usePluginPanelsStore((s) => s.plugins)
  const pluginFetchStatus = usePluginPanelsStore((s) => s.fetchStatus)
  const pluginPanelErrors = usePluginPanelsStore((s) => s.panelErrors)
  const installedPluginTabKeys = useMemo(
    () => collectInstalledPluginTabKeys(installedPlugins),
    [installedPlugins]
  )
  // Why here: the checks tab announces this status, so a plugin tab's name is judged against it.
  const creatingWorktree = useAppStore(selectWorktreeCreationSurfaceShown)
  const checksStatus = useAppStore((s) =>
    s.rightSidebarOpen && !creatingWorktree ? getActiveChecksStatus(s) : null
  )

  // A bot's page labels every tab (labeledTab): Home, Connectors, Chats, Files.
  const activityItems = useMemo<ActivityBarItem[]>(() => {
    const builtInItems = getDefaultRightSidebarActivityItems({
      t,
      explorerShortcut,
      sourceControlShortcut,
      checksShortcut,
      portsShortcut,
      agentsShortcut,
      isBot,
      showsHomeTab,
      needsYou,
      connectorsNeedingOwner
    })
    return [
      ...builtInItems,
      // Append plugin tabs to preserve built-in navigation positions. Checked against every built-in
      // label, not only the visible ones, so a plugin tab's name never depends on what is shown.
      ...getPluginPanelActivityItems(
        visiblePluginPanels,
        pluginPanelErrors,
        builtInTabNames(builtInItems, t)
      ).map((item) => ({
        ...item,
        labeledTab: isBot
      }))
    ]
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [
    agentsShortcut,
    checksShortcut,
    explorerShortcut,
    pluginPanelErrors,
    visiblePluginPanels,
    portsShortcut,
    sourceControlShortcut,
    isBot,
    showsHomeTab,
    needsYou,
    connectorsNeedingOwner,
    languageRevision,
    t
  ])

  // Why after visibility: only tabs on screen together need names a screen reader can tell apart.
  const visibleItems = useMemo(
    () =>
      withDistinctPluginPanelNames(
        getVisibleRightSidebarActivityItems(activityItems, {
          isFolder,
          isFolderWorkspace,
          hasRemoteHost,
          isBot,
          isGroupHome,
          hasChatWorkers
        }),
        (item) => item.statusIndicator ?? (item.id === 'checks' ? checksStatus : null)
      ),
    [
      activityItems,
      isFolder,
      isFolderWorkspace,
      hasRemoteHost,
      isBot,
      isGroupHome,
      hasChatWorkers,
      checksStatus
    ]
  )

  const activeFolderWorkspaceKey = isFolderWorkspace ? (activeWorktreeId ?? null) : null

  return {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys,
    isBotPage: isBot
  }
}
