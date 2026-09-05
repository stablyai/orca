/**
 * Fixtures for the automations page characterization tests.
 *
 * The automation defaults are deliberately the *runnable* shape — a local record
 * whose repo has no SSH connection — so Run Now reaches its handler instead of
 * being refused by the availability gate. Tests that need an unrunnable record
 * override the fields they care about.
 */

import type {
  Automation,
  AutomationRun,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ExternalAutomationScope,
  ScopedExternalAutomationManager
} from './external-automation-scope-client'
import { automationListRowKey, type AutomationListRow } from './automation-list-row-identity'
import { ALL_AUTOMATION_HOSTS_FILTER } from '../../../../shared/automation-host-filter'
import { getDefaultSettings } from '../../../../shared/constants'

export const REPO_ID = 'repo-1'
export const WORKSPACE_ID = 'workspace-1'

export function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Nightly',
    prompt: 'Run the nightly sweep',
    precheck: null,
    agentId: 'claude',
    runContext: null,
    projectId: REPO_ID,
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** A list row for a record on a given host; the host defaults to the desktop. */
export function makeAutomationListRow(
  overrides: Partial<AutomationListRow> & { hostStableKey?: string } = {}
): AutomationListRow {
  const automation = overrides.automation ?? makeAutomation()
  const hostStableKey = overrides.hostStableKey ?? 'host:desktop:self'
  return {
    key: overrides.key ?? automationListRowKey(hostStableKey, automation.id),
    automation,
    hostLabel: overrides.hostLabel ?? 'This computer',
    usageSummary: overrides.usageSummary ?? null
  }
}

export function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'a-1',
    title: 'Nightly #1',
    scheduledFor: 10,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 10,
    dispatchedAt: 10,
    createdAt: 10,
    ...overrides
  }
}

export function makeExternalManager(
  overrides: Partial<ExternalAutomationManager> = {}
): ExternalAutomationManager {
  return {
    id: 'hermes:local',
    provider: 'hermes',
    label: 'Hermes',
    targetLabel: 'This computer',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: [
      {
        id: 'job-1',
        managerId: 'hermes:local',
        provider: 'hermes',
        name: 'Hermes job',
        schedule: 'Daily at 09:00',
        rawSchedule: '0 9 * * *',
        enabled: true,
        state: 'active',
        prompt: null,
        promptPreview: 'Sweep',
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        workdir: null,
        runCount: 0,
        runs: []
      }
    ],
    ...overrides
  }
}

/** The desktop-self scope every manager fixture is discovered under by default. */
export function makeExternalAutomationScope(
  overrides: Partial<ExternalAutomationScope> = {}
): ExternalAutomationScope {
  return {
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'self' }
    },
    provider: 'hermes',
    ...overrides
  }
}

export function makeScopedExternalManager(
  overrides: Partial<ExternalAutomationManager> = {},
  scope: ExternalAutomationScope = makeExternalAutomationScope()
): ScopedExternalAutomationManager {
  return { scope, manager: makeExternalManager(overrides) }
}

function makeRepo(): Repo {
  return {
    id: REPO_ID,
    displayName: 'orca',
    path: '/repos/orca',
    badgeColor: '#000000',
    addedAt: 1,
    worktreeBaseRef: 'main'
  }
}

/** Ready and local, so the editor can build a run context and state a Self destination. */
function makeProjectHostSetup(): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: REPO_ID,
    path: '/repos/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorktree(): Worktree {
  return {
    id: WORKSPACE_ID,
    repoId: REPO_ID,
    displayName: 'main',
    path: '/repos/orca',
    branch: 'main'
  } as Worktree
}

export type AutomationsPageStoreFixtures = {
  state: Record<string, unknown>
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
}

/** A store shaped like the page's reads; actions are spies so nothing escapes the test. */
export function makeStoreState(): AutomationsPageStoreFixtures {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const noop = (): void => undefined
  return {
    state: {
      repos: [repo],
      projectHostSetups: [makeProjectHostSetup()],
      worktreesByRepo: { [REPO_ID]: [worktree] },
      unifiedTabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      activeWorktreeId: null,
      fetchWorktrees: noop,
      fetchAllWorktrees: noop,
      fetchRuntimeEnvironmentRepos: async () => [],
      startupWorktreeRefreshCompleted: true,
      updateSettings: noop,
      openSettingsPage: noop,
      openSettingsTarget: noop,
      closeAutomationsPage: noop,
      activeModal: 'none',
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      removedSshTargetLabels: new Map(),
      // Hydrated with no targets: the desktop authority has looked and has none,
      // so the catalog projects Desktop + Self and nothing else.
      sshTargetsHydrated: true,
      sshStateByEnvironment: new Map(),
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogSettled: true,
      runtimeStatusByEnvironmentId: new Map(),
      automationHostFilter: ALL_AUTOMATION_HOSTS_FILTER,
      setAutomationHostFilter: noop,
      settings: getDefaultSettings('/tmp'),
      preflightStatus: null,
      preflightStatusChecked: true,
      preflightStatusContextKey: null,
      refreshPreflightStatus: noop,
      selectedAutomationId: null,
      setSelectedAutomationId: noop,
      pendingAutomationRunNavigation: null,
      setPendingAutomationRunNavigation: noop,
      hydratePersistedUI: noop,
      recordFeatureInteraction: noop,
      allWorktrees: () => [worktree],
      getKnownWorktreeById: () => worktree
    },
    repoMap: new Map([[REPO_ID, repo]]),
    worktreeMap: new Map([[WORKSPACE_ID, worktree]])
  }
}
