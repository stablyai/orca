import {
  Activity,
  Files,
  GitBranch,
  House,
  ListChecks,
  MessagesSquare,
  Plug,
  Workflow
} from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import type { ActivityBarItem } from './activity-bar-buttons'

export function getDefaultRightSidebarActivityItems({
  t,
  explorerShortcut,
  sourceControlShortcut,
  checksShortcut,
  portsShortcut,
  isBot = false,
  showsHomeTab = isBot,
  needsYou = 0,
  connectorsNeedingOwner = 0
}: {
  t: Translate
  explorerShortcut: string
  sourceControlShortcut: string
  checksShortcut: string
  portsShortcut: string
  isBot?: boolean
  showsHomeTab?: boolean
  needsYou?: number
  connectorsNeedingOwner?: number
}): ActivityBarItem[] {
  return [
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
      icon: showsHomeTab ? House : Activity,
      title: showsHomeTab ? t('bots.items.tab', 'Home') : t('bots.activity.title', 'Activity'),
      shortcut: '',
      botOnly: true,
      labeledTab: showsHomeTab,
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
      remoteHostOnly: true
    }
  ]
}
