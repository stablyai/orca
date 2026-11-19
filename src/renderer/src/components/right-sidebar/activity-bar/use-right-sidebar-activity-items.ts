import { useMemo } from 'react'
import {
  Activity,
  Plug,
  Files,
  GitBranch,
  ListChecks,
  ListTodo,
  MessagesSquare,
  Workflow
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { getPluginPanelActivityItems } from '../plugin-panels/plugin-panel-activity-items'
import {
  getPortsPanelOwnerKey,
  portsPanelHostForOwnerKey,
  portsPanelReachesSshHost
} from '../ports/ports-panel-host'
import {
  collectInstalledPluginTabKeys,
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelsFetchStatus
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import type { ActivityBarItem } from './activity-bar-buttons'
import { useBotForWorkspace, useBotGroupForWorkspace } from '../../bots/bot-workspace'
import { useFocusedChatWorkers } from '@/lib/focused-chat-workers'
import { useBotNeedsYouCount, useBotNow } from '../../bots/use-bot-now'

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
  const isGroupHome = useBotGroupForWorkspace(isFolderWorkspace ? activeWorktreeId : null) !== null
  const now = useBotNow(bot)
  const { needs } = now
  // A bot's first tab is Items: its badge counts Orca's asks and items in Needs you.
  const needsYou = useBotNeedsYouCount(bot, now)
  // The same read as Activity's count, so connector reads aren't repeated for the tab.
  const connectorsNeedingOwner = needs.filter((need) => need.kind === 'connector').length
  const hasChatWorkers = useFocusedChatWorkers(rightSidebarOpen && !isBot).workers.length > 0
  // Why the owner: a managed server's workspace names its server, not an SSH connection.
  const hasSshHost = useAppStore((s) =>
    portsPanelReachesSshHost(
      portsPanelHostForOwnerKey(getPortsPanelOwnerKey(s, activeWorktreeId)),
      s.runtimeEnvironments
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

  // A bot's page labels every tab (labeledTab): Items, Connectors, Chats, Files.
  const activityItems = useMemo<ActivityBarItem[]>(
    () => [
      {
        id: 'explorer',
        icon: Files,
        title: isBot
          ? t('bots.files.tab', 'Files')
          : t('auto.components.right.sidebar.index.8bc2bbc3a0', 'Explorer'),
        shortcut: explorerShortcut === 'Unassigned' ? '' : explorerShortcut,
        onBotPage: true,
        labeledTab: isBot
      },
      {
        id: 'bot-activity',
        icon: isBot ? ListTodo : Activity,
        title: isBot ? t('bots.items.tab', 'Items') : t('bots.activity.title', 'Activity'),
        shortcut: '',
        botOnly: true,
        labeledTab: isBot,
        ...(needsYou > 0
          ? {
              count: needsYou,
              countLabel: t('bots.connectors.needYou', '{{count}} need you', {
                count: needsYou,
                defaultValue_one: '{{count}} needs you'
              })
            }
          : {})
      },
      {
        id: 'bot-connectors',
        icon: Plug,
        title: t('bots.connectors.tab', 'Connectors'),
        shortcut: '',
        botPageOnly: true,
        labeledTab: isBot,
        ...(connectorsNeedingOwner > 0
          ? {
              count: connectorsNeedingOwner,
              countLabel: t('bots.connectors.needYou', '{{count}} need you', {
                count: connectorsNeedingOwner,
                defaultValue_one: '{{count}} needs you'
              })
            }
          : {})
      },
      {
        id: 'bot-chats',
        icon: MessagesSquare,
        title: t('bots.chats.title', 'Chats'),
        shortcut: '',
        botPageOnly: true,
        labeledTab: isBot
      },
      {
        id: 'vault',
        icon: AgentSessionHistoryIcon,
        title: t('auto.components.right.sidebar.index.aiVaultSessionHistory', 'Agents'),
        shortcut: ''
      },
      {
        id: 'workspaces',
        icon: Workflow,
        title: t('auto.components.right.sidebar.index.folderWorkspaces', 'Attached worktrees'),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'pr-checks',
        icon: ListChecks,
        title: t('auto.components.right.sidebar.index.parentPrChecks', 'PR Checks'),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'source-control',
        icon: GitBranch,
        title: t('auto.components.right.sidebar.index.0314901467', 'Source Control'),
        shortcut: sourceControlShortcut === 'Unassigned' ? '' : sourceControlShortcut,
        gitOnly: true
      },
      {
        id: 'checks',
        icon: ListChecks,
        title: t('auto.components.right.sidebar.index.83a10e3c44', 'Checks'),
        shortcut: checksShortcut === 'Unassigned' ? '' : checksShortcut,
        gitOnly: true
      },
      {
        id: 'ports',
        icon: Plug,
        title: t('auto.components.right.sidebar.index.441733b630', 'Ports'),
        shortcut: portsShortcut === 'Unassigned' ? '' : portsShortcut,
        sshOnly: true
      },
      // Append plugin tabs to preserve built-in navigation positions.
      ...getPluginPanelActivityItems(visiblePluginPanels, pluginPanelErrors).map((item) => ({
        ...item,
        labeledTab: isBot
      }))
    ],
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [
      checksShortcut,
      explorerShortcut,
      pluginPanelErrors,
      visiblePluginPanels,
      portsShortcut,
      sourceControlShortcut,
      isBot,
      needsYou,
      connectorsNeedingOwner,
      languageRevision,
      t
    ]
  )

  const visibleItems = useMemo(
    () =>
      getVisibleRightSidebarActivityItems(activityItems, {
        isFolder,
        isFolderWorkspace,
        hasSshHost,
        isBot,
        isGroupHome,
        hasChatWorkers
      }),
    [activityItems, isFolder, isFolderWorkspace, hasSshHost, isBot, isGroupHome, hasChatWorkers]
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
