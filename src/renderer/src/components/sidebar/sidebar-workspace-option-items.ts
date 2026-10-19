import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import {
  WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES,
  WORKSPACE_CARD_LAYOUT_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES,
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_PROJECT_ORDER_CHOICES,
  WORKSPACE_SORT_BY_CHOICES,
  WORKSPACE_CARD_DISPLAY_CHOICES,
  type WorkspaceViewChoice
} from '../../../../shared/workspace-view/workspace-view-options'
import { translate } from '@/i18n/i18n'

// The shared Workspace options choices with the desktop's localized copy. Each table is keyed on
// the shared ids, so a choice added in shared fails to compile here until it has a label.

type LocalizedChoice<Id extends string> = {
  id: Id
  readonly label: string
  readonly description: string | null
}

function localizeChoices<Id extends string>(
  choices: readonly WorkspaceViewChoice<Id>[],
  labels: Record<Id, () => string>,
  descriptions: Partial<Record<Id, () => string>> = {}
): LocalizedChoice<Id>[] {
  return choices.map(({ id }) => ({
    id,
    get label() {
      return labels[id]()
    },
    get description() {
      return descriptions[id]?.() ?? null
    }
  }))
}

type ChoiceId<T extends readonly WorkspaceViewChoice<string>[]> = T[number]['id']

const projectLabel = (): string =>
  translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.2170d553cf', 'Project')
const manualLabel = (): string =>
  translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.7b316bdd51', 'Manual')
const recentLabel = (): string =>
  translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162', 'Recent')
const compactLabel = (): string =>
  translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb', 'Compact')

export const GROUP_BY_OPTIONS = localizeChoices<ChoiceId<typeof WORKSPACE_GROUP_BY_CHOICES>>(
  WORKSPACE_GROUP_BY_CHOICES,
  {
    none: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.c2c7a45cda', 'None'),
    'workspace-status': () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.e029a2d775', 'Status'),
    'pr-status': () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.0f9b959b31', 'PR'),
    repo: projectLabel
  }
)

export const SORT_OPTIONS = localizeChoices<ChoiceId<typeof WORKSPACE_SORT_BY_CHOICES>>(
  WORKSPACE_SORT_BY_CHOICES,
  {
    name: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.3728165cdd', 'Name'),
    smart: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.503462f2b4', 'Agent Activity'),
    recent: recentLabel,
    repo: projectLabel,
    manual: manualLabel
  },
  {
    smart: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.b759bb87ee',
        'Agents that need attention, then most recent activity.'
      ),
    manual: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.7153d07485',
        'Drag workspaces to arrange them within each group.'
      )
  }
)

export const PROJECT_ORDER_OPTIONS = localizeChoices<
  ChoiceId<typeof WORKSPACE_PROJECT_ORDER_CHOICES>
>(
  WORKSPACE_PROJECT_ORDER_CHOICES,
  { manual: manualLabel, recent: recentLabel },
  {
    manual: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.6664282a7b',
        'Drag projects to arrange them'
      ),
    recent: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceOptionsMenu.af9249c505',
        'Most recent workspace activity'
      )
  }
)

export const CARD_LAYOUT_OPTIONS = localizeChoices<ChoiceId<typeof WORKSPACE_CARD_LAYOUT_CHOICES>>(
  WORKSPACE_CARD_LAYOUT_CHOICES,
  {
    detailed: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.cc17bd443b', 'Detailed'),
    compact: compactLabel
  }
)

export const AGENT_ACTIVITY_DISPLAY_OPTIONS = localizeChoices<
  ChoiceId<typeof WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES>
>(WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES, {
  compact: compactLabel,
  full: () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.2a81e07366', 'Full list')
})

export const PROPERTY_OPTIONS = localizeChoices<ChoiceId<typeof WORKSPACE_CARD_PROPERTY_CHOICES>>(
  WORKSPACE_CARD_PROPERTY_CHOICES,
  {
    issue: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.91dfc653e8', 'GitHub ticket'),
    'linear-issue': () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.ca4d3c522e', 'Linear issue'),
    'jira-issue': () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.jiraIssue', 'Jira issue'),
    pr: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b8dcc6f321', 'PR/MR link'),
    automation: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.automation', 'Automation'),
    comment: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.26c71e536c', 'Notes'),
    ports: () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b64d8bcca0', 'Ports'),
    'inline-agents': () =>
      translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.d7084e8bc8', 'Agent activity'),
    host: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.host', 'Host')
  }
)

const CARD_DISPLAY_LABELS: Record<
  ChoiceId<typeof WORKSPACE_CARD_DISPLAY_CHOICES>,
  (hasProjectGroups: boolean) => string
> = {
  issue: () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.bdd23b4e07', 'GitHub issues'),
  'linear-issue': () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.44713a5d04', 'Linear issues'),
  'jira-issue': () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.jiraIssues', 'Jira issues'),
  comment: () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.8d62c68b35', 'Notes'),
  automation: () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.automation', 'Automation'),
  cli: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.cli', 'Orca CLI'),
  ports: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.2d74665a56', 'Ports'),
  'inline-agents': () =>
    translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.65a9820bd1', 'Agent statuses'),
  host: () => translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.host', 'Host'),
  branch: (hasProjectGroups) =>
    hasProjectGroups
      ? translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.folderPathIdentity',
          'Branch / folder path'
        )
      : translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.219ebf1961', 'Branch name')
}

/** "Card display" rows for the experimental card style. */
export function getWorktreeCardDisplayOptions(
  hasProjectGroups: boolean
): { id: WorktreeCardProperty; readonly label: string }[] {
  return WORKSPACE_CARD_DISPLAY_CHOICES.map(({ id }) => ({
    id,
    get label() {
      return CARD_DISPLAY_LABELS[id](hasProjectGroups)
    }
  }))
}
