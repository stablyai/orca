import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import {
  AUTOMATION_ORPHAN_ISSUES,
  automationChangePublications,
  automationSelectorMatchesScope,
  projectAutomationList,
  projectAutomationSelector,
  toAutomationChangeSelector,
  type AutomationProjectionContext
} from './automation-list-scope'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Automation
}

function context(
  overrides: Partial<AutomationProjectionContext> = {}
): AutomationProjectionContext {
  return {
    sshTargetGeneration: (targetId) => (targetId === 'ssh-1' ? 7 : undefined),
    repoConnectionId: (repoId) =>
      repoId === 'repo-1' ? null : repoId === 'repo-ssh' ? 'ssh-1' : undefined,
    ...overrides
  }
}

describe('capability advertisement', () => {
  it('registers both automation capabilities so getStatus() advertises them', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY)
  })
})

describe('projectAutomationSelector', () => {
  it('qualifies a local record whose project resolves without a connection as self', () => {
    expect(projectAutomationSelector(automation(), context())).toEqual({ kind: 'self' })
  })

  it('refuses to read a bare local value as self when the project is gone', () => {
    expect(projectAutomationSelector(automation({ projectId: 'missing' }), context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.projectMissing
    })
  })

  it('treats a local record whose project points at an SSH connection as malformed', () => {
    expect(projectAutomationSelector(automation({ projectId: 'repo-ssh' }), context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.malformed
    })
  })

  it('pins an SSH record to its registration generation', () => {
    const record = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 7,
      projectId: 'repo-ssh'
    })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1',
      targetGeneration: 7
    })
  })

  it('orphans an SSH record whose target was removed and re-added', () => {
    const record = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 5
    })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })

  it('orphans an SSH record whose target is gone', () => {
    const record = automation({ executionTargetType: 'ssh', executionTargetId: 'ssh-gone' })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })

  it('never assigns a runtime-scheduled record to another authority', () => {
    const record = automation({ schedulerOwner: 'remote_host_service' })
    expect(projectAutomationSelector(record, context())).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere
    })
    const byHostId = automation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'p',
        hostId: 'runtime:env-1',
        projectHostSetupId: 's',
        repoId: 'repo-1',
        path: '/tmp'
      }
    })
    expect(projectAutomationSelector(byHostId, context()).kind).toBe('orphan')
  })
})

describe('automationSelectorMatchesScope', () => {
  it('requires the SSH generation to match, not just the target id', () => {
    const selector = { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } as const
    expect(
      automationSelectorMatchesScope(selector, {
        kind: 'ssh',
        targetId: 'ssh-1',
        expectedTargetGeneration: 7
      })
    ).toBe(true)
    expect(
      automationSelectorMatchesScope(selector, {
        kind: 'ssh',
        targetId: 'ssh-1',
        expectedTargetGeneration: 6
      })
    ).toBe(false)
  })
})

describe('projectAutomationList', () => {
  const records = [
    automation({ id: 'local-1' }),
    automation({
      id: 'ssh-a',
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 7,
      projectId: 'repo-ssh'
    }),
    automation({ id: 'orphan-1', executionTargetType: 'ssh', executionTargetId: 'ssh-gone' })
  ]

  it('returns every record with one item each when no scope is requested', () => {
    const result = projectAutomationList(records, context())
    expect(result.automations).toHaveLength(3)
    expect(result.items.map((item) => item.automationId)).toEqual(['local-1', 'ssh-a', 'orphan-1'])
    expect(result.orphanCount).toBe(1)
  })

  it('narrows to one host while still reporting the authority orphan count', () => {
    const result = projectAutomationList(records, context(), { kind: 'self' })
    expect(result.automations.map((entry) => entry.id)).toEqual(['local-1'])
    expect(result.orphanCount).toBe(1)
  })

  it('attaches bounded usage summaries when the authority supplies them', () => {
    const result = projectAutomationList(records, {
      ...context(),
      usageSummary: (id) =>
        id === 'local-1'
          ? {
              knownRuns: 2,
              unavailableRuns: 0,
              inputTokens: 1,
              outputTokens: 2,
              cacheTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 3,
              estimatedCostUsd: null
            }
          : null
    })
    expect(result.items[0]?.usageSummary?.knownRuns).toBe(2)
    expect(result.items[1]?.usageSummary).toBeNull()
  })

  it('projects and scopes in one collection traversal', () => {
    const collectionMethodReads: string[] = []
    const repoLookups: string[] = []
    const targetLookups: string[] = []
    const source = new Proxy(records, {
      get(target, property, receiver) {
        if (property === 'map' || property === 'filter') {
          collectionMethodReads.push(String(property))
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const usageIds: string[] = []
    const result = projectAutomationList(
      source,
      {
        ...context(),
        repoConnectionId: (repoId) => {
          repoLookups.push(repoId)
          return repoId === 'repo-1' ? null : repoId === 'repo-ssh' ? 'ssh-1' : undefined
        },
        sshTargetGeneration: (targetId) => {
          targetLookups.push(targetId)
          return targetId === 'ssh-1' ? 7 : undefined
        },
        usageSummary: (id) => {
          usageIds.push(id)
          return null
        }
      },
      { kind: 'self' }
    )

    expect(collectionMethodReads).toEqual([])
    expect(result.automations.map((entry) => entry.id)).toEqual(['local-1'])
    expect(result.items.map((item) => item.automationId)).toEqual(['local-1'])
    expect(result.items[0]?.selector).toEqual({ kind: 'self' })
    expect(result.orphanCount).toBe(1)
    expect(repoLookups).toEqual(['repo-1'])
    expect(targetLookups).toEqual(['ssh-1', 'ssh-gone'])
    expect(usageIds).toEqual(['local-1'])
  })
})

describe('automationChangePublications', () => {
  it('publishes one event when the record stays on its host', () => {
    expect(automationChangePublications({ kind: 'self' }, { kind: 'self' })).toEqual([
      { kind: 'self' }
    ])
  })

  it('publishes source and destination when the record moves', () => {
    expect(automationChangePublications({ kind: 'self' }, { kind: 'ssh', targetId: 't1' })).toEqual(
      [{ kind: 'self' }, { kind: 'ssh', targetId: 't1' }]
    )
  })

  it('treats two SSH hosts as a move', () => {
    expect(
      automationChangePublications({ kind: 'ssh', targetId: 't1' }, { kind: 'ssh', targetId: 't2' })
    ).toEqual([
      { kind: 'ssh', targetId: 't1' },
      { kind: 'ssh', targetId: 't2' }
    ])
  })

  // Why: a partial publication would leave the unnamed side showing a row that moved away.
  it('degrades to one unscoped event when either side is unknown', () => {
    expect(automationChangePublications(null, { kind: 'self' })).toEqual([undefined])
    expect(automationChangePublications({ kind: 'self' }, null)).toEqual([undefined])
  })

  it('drops the incarnation when narrowing a projected selector', () => {
    expect(
      toAutomationChangeSelector({ kind: 'ssh', targetId: 't1', targetGeneration: 9 })
    ).toEqual({ kind: 'ssh', targetId: 't1' })
    expect(toAutomationChangeSelector({ kind: 'orphan', issue: 'gone' })).toEqual({
      kind: 'orphan'
    })
  })
})

// A folder workspace can pin its host directly, and that pin is what dispatch uses.
// Projecting from the repo alone filed those records under Self while they ran elsewhere.
describe('workspace host pin', () => {
  it('files a local record under the SSH host its workspace pins', () => {
    const selector = projectAutomationSelector(
      automation({ workspaceId: 'folder:fw-1' }),
      context({ workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-1' }) })
    )

    expect(selector).toEqual({ kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 })
  })

  it('orphans a pin whose SSH target is no longer registered', () => {
    const selector = projectAutomationSelector(
      automation({ workspaceId: 'folder:fw-1' }),
      context({ workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-gone' }) })
    )

    expect(selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })

  it('orphans a workspace that resolves to more than one host instead of assuming Self', () => {
    const selector = projectAutomationSelector(
      automation({ workspaceId: 'folder:fw-1' }),
      context({ workspaceHost: () => ({ kind: 'ambiguous' }) })
    )

    expect(selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous
    })
  })

  it('leaves the repo in charge when nothing pins the workspace', () => {
    expect(
      projectAutomationSelector(
        automation(),
        context({ workspaceHost: () => ({ kind: 'unpinned' }) })
      )
    ).toEqual({ kind: 'self' })
    expect(
      projectAutomationSelector(
        automation({
          projectId: 'repo-ssh',
          runContext: { repoId: 'repo-ssh' }
        } as Partial<Automation>),
        context({ workspaceHost: () => ({ kind: 'local' }) })
      )
    ).toEqual({ kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.malformed })
  })
})
