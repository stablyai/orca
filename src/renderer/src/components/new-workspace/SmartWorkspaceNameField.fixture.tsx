import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { getLocalPreflightContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { localPreflightContextKey } from '@/runtime/hosts/preflight/local-preflight-context-key'
import { useAppStore } from '@/store'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { buildTaskSourceContextFromRepo } from '../../../../shared/work-items/task-source-context'
import type {
  JiraConnectionStatus,
  JiraIssue,
  JiraProject
} from '../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import SmartWorkspaceNameField from './SmartWorkspaceNameField'
import type { SmartWorkspaceNameFieldProps } from './name-field/smart-workspace-name-field-model'

const repo: Repo = {
  id: 'repo-orca',
  path: '/Users/dev/orca',
  displayName: 'orca',
  badgeColor: '#64748b',
  addedAt: 0
}

const jiraSourceContext = buildTaskSourceContextFromRepo({
  provider: 'jira',
  projectId: repo.id,
  repo
})

const linearStatusFixture: LinearConnectionStatus = {
  connected: true,
  viewer: null,
  selectedWorkspaceId: 'all',
  activeWorkspaceId: 'ws-stably',
  workspaces: [
    {
      id: 'ws-stably',
      organizationId: 'org-stably',
      organizationName: 'Stably',
      displayName: 'Dev User',
      email: 'dev@stably.ai'
    },
    {
      id: 'ws-platform',
      organizationId: 'org-platform',
      organizationName: 'Platform Ops',
      displayName: 'Dev User',
      email: 'dev@stably.ai'
    }
  ]
}

function makeLinearIssue(
  id: string,
  workspaceId: string,
  workspaceName: string,
  identifier: string,
  title: string
): LinearIssue {
  return {
    id,
    workspaceId,
    workspaceName,
    identifier,
    title,
    url: `https://linear.app/stably/issue/${identifier}`,
    state: { name: 'Todo', type: 'unstarted', color: '#94a3b8' },
    team: { id: 'team-1', name: workspaceName, key: 'STA' },
    labels: [],
    labelIds: [],
    priority: 2,
    updatedAt: '2026-11-12T00:00:00.000Z'
  }
}

const linearIssuesFixture: LinearIssue[] = [
  makeLinearIssue(
    'lin-1',
    'ws-stably',
    'Stably',
    'STA-3699',
    'Update installer swaps app.asar under the running renderer'
  ),
  makeLinearIssue(
    'lin-2',
    'ws-stably',
    'Stably',
    'STA-6457',
    '[Bug]: AppImage squashfs is unmounted before helper exits'
  ),
  makeLinearIssue(
    'lin-3',
    'ws-platform',
    'Platform Ops',
    'STA-14948',
    "Release scan P2: Claude Code doesn't resume after a host reconnect"
  )
]

const jiraProjectsFixture: JiraProject[] = [
  {
    id: '100',
    key: 'ORCA',
    name: 'Orca Desktop',
    siteId: 'site-1',
    siteName: 'stably.atlassian.net'
  },
  {
    id: '101',
    key: 'INFRA',
    name: 'Runtime Infra',
    siteId: 'site-1',
    siteName: 'stably.atlassian.net'
  }
]

const jiraStatusFixture: JiraConnectionStatus = {
  connected: true,
  viewer: null,
  selectedSiteId: 'site-1',
  activeSiteId: 'site-1',
  sites: [
    {
      id: 'site-1',
      siteUrl: 'https://stably.atlassian.net',
      email: 'dev@stably.ai',
      displayName: 'stably.atlassian.net',
      accountId: 'acc-1'
    }
  ]
}

function makeJiraIssue(id: string, key: string, title: string, project: JiraProject): JiraIssue {
  return {
    id,
    key,
    siteId: 'site-1',
    siteName: 'stably.atlassian.net',
    title,
    url: `https://stably.atlassian.net/browse/${key}`,
    project,
    issueType: { id: '1', name: 'Task' },
    status: {
      id: '1',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    },
    labels: [],
    updatedAt: '2026-11-12T00:00:00.000Z',
    createdAt: '2026-11-11T00:00:00.000Z'
  }
}

const jiraIssuesFixture: JiraIssue[] = [
  makeJiraIssue(
    'jira-1',
    'ORCA-412',
    'Align scope pickers inside workspace source results popover',
    jiraProjectsFixture[0]
  ),
  makeJiraIssue(
    'jira-2',
    'ORCA-389',
    'Keep composer search input stationary across provider tabs',
    jiraProjectsFixture[0]
  ),
  makeJiraIssue(
    'jira-3',
    'INFRA-104',
    'Preserve remote SSH runtime capabilities across daemon upgrades',
    jiraProjectsFixture[1]
  )
]

function seedSourceProviders(): void {
  window.api = {
    ...window.api,
    linear: {
      ...window.api.linear,
      status: async () => linearStatusFixture,
      listIssues: async (payload) => ({
        items:
          payload?.workspaceId && payload.workspaceId !== 'all'
            ? linearIssuesFixture.filter((issue) => issue.workspaceId === payload.workspaceId)
            : linearIssuesFixture
      }),
      searchIssues: async (payload) =>
        payload.workspaceId && payload.workspaceId !== 'all'
          ? linearIssuesFixture.filter((issue) => issue.workspaceId === payload.workspaceId)
          : linearIssuesFixture
    },
    jira: {
      ...window.api.jira,
      status: async () => jiraStatusFixture,
      listProjects: async () => jiraProjectsFixture,
      searchIssues: async () => jiraIssuesFixture
    }
  }

  const currentState = useAppStore.getState()
  useAppStore.setState({
    repos: [repo],
    linearStatus: linearStatusFixture,
    linearStatusObserved: true,
    linearStatusChecked: true,
    linearStatusContextKey: getProviderRuntimeContextKey(currentState.settings),
    checkLinearConnection: async () => {},
    preflightStatus: {
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    },
    preflightStatusChecked: true,
    preflightStatusContextKey: localPreflightContextKey(getLocalPreflightContext(currentState)),
    refreshPreflightStatus: async () => {},
    fetchWorkItems: async () => {},
    fetchWorkItemsAcrossRepos: async () => {},
    getCachedWorkItems: () => [],
    readJiraStatus: async () => jiraStatusFixture,
    searchJiraIssues: async () => jiraIssuesFixture
  })
}

function ComposerSurfacePreview({ initialQuery = '' }: { initialQuery?: string }) {
  const [value, setValue] = useState(initialQuery)
  const [selectedSource, setSelectedSource] =
    useState<SmartWorkspaceNameFieldProps['selectedSource']>(null)
  return (
    <div className="space-y-4 rounded-xl border border-border bg-background p-4">
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Create From <span className="text-muted-foreground/70">[Optional]</span>
        </span>
        <SmartWorkspaceNameField
          repos={[repo]}
          selectedRepo={repo}
          repoId={repo.id}
          onRepoChange={() => {}}
          value={value}
          onValueChange={setValue}
          onGitHubItemSelect={() => {}}
          onGitLabItemSelect={() => {}}
          onBranchSelect={() => {}}
          onLinearIssueSelect={(issue) =>
            setSelectedSource({
              kind: 'linear',
              label: `${issue.identifier} ${issue.title}`,
              url: issue.url
            })
          }
          onJiraIssueSelect={(issue) =>
            setSelectedSource({
              kind: 'jira',
              label: `${issue.key} ${issue.title}`,
              url: issue.url
            })
          }
          selectedSource={selectedSource}
          onClearSelectedSource={() => setSelectedSource(null)}
          jiraSourceContext={jiraSourceContext}
          branchesEnabled
        />
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Agent [Optional]</span>
        <div className="flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
          Claude Code
        </div>
      </div>
      <div>
        <Button type="button" variant="ghost" size="xs" className="-ml-2">
          Advanced
          <ChevronDown />
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm">
          Create
        </Button>
      </div>
    </div>
  )
}

function pressControl(element: HTMLElement | null): void {
  if (!element) {
    return
  }
  const init = { bubbles: true, cancelable: true, button: 0 }
  element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }))
  element.dispatchEvent(new MouseEvent('mousedown', init))
  element.click()
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function selectMode(frame: HTMLElement, mode: string): Promise<void> {
  await wait(60)
  const tab = frame.querySelector<HTMLElement>(`[data-smart-name-mode="${mode}"]`)
  if (!tab) {
    throw new Error(`Missing source tab: ${mode}`)
  }
  pressControl(tab)
  await wait(260)
}

function openScopeDropdown(ariaLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`)
  if (!trigger) {
    throw new Error(`Missing ${ariaLabel} dropdown trigger`)
  }
  pressControl(trigger)
}

export const gitlab = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview />,
  interact: (frame) => selectMode(frame, 'gitlab')
})

export const linear = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview />,
  interact: (frame) => selectMode(frame, 'linear')
})

export const linearDropdownOpen = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview />,
  interact: async (frame) => {
    await selectMode(frame, 'linear')
    openScopeDropdown('Linear workspace')
    await wait(80)
    if (!document.querySelector('[data-workspace-source-suggestions="true"]')) {
      throw new Error('Source suggestions popover closed when opening Linear workspace dropdown')
    }
  }
})

export const linearFilteredWorkspace = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview />,
  interact: async (frame) => {
    await selectMode(frame, 'linear')
    openScopeDropdown('Linear workspace')
    await wait(80)
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.includes('Platform Ops')
    )
    if (!option) {
      throw new Error('Missing Platform Ops workspace option')
    }
    pressControl(option)
    await wait(120)
    if (!document.querySelector('[data-workspace-source-suggestions="true"]')) {
      throw new Error('Source suggestions popover closed after selecting Linear workspace')
    }
    if (document.activeElement?.getAttribute('data-workspace-name-input') !== 'true') {
      throw new Error('Focus did not return to workspace search input after workspace selection')
    }
  }
})

export const jira = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview initialQuery="ORCA" />,
  interact: (frame) => selectMode(frame, 'jira')
})

export const jiraDropdownOpen = defineFixture({
  width: 480,
  setup: seedSourceProviders,
  render: () => <ComposerSurfacePreview initialQuery="ORCA" />,
  interact: async (frame) => {
    await selectMode(frame, 'jira')
    openScopeDropdown('Jira project')
    await wait(80)
    if (!document.querySelector('[data-workspace-source-suggestions="true"]')) {
      throw new Error('Source suggestions popover closed when opening Jira project dropdown')
    }
  }
})
