import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import type { AutomationProjectionContext } from './automation-list-scope'
import { AUTOMATION_OWNER_CONFLICT_CODES } from './automation-owner-conflict'
import {
  assertAutomationDestination,
  assertAutomationOwnerFence,
  assertExecutionTargetMatchesDestination
} from './automation-owner-precondition'

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

const context: AutomationProjectionContext = {
  sshTargetGeneration: (targetId) => (targetId === 'ssh-1' ? 7 : undefined),
  repoConnectionId: (repoId) =>
    repoId === 'repo-1' ? null : repoId === 'repo-ssh' ? 'ssh-1' : undefined
}

const sshRecord = automation({
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-1',
  executionTargetGeneration: 7,
  projectId: 'repo-ssh'
})

/** A `local` record its folder workspace pins to SSH: SSH-owned by projection, not by storage. */
const pinnedLocalRecord = automation({ workspaceId: 'folder:fw-1' })
const pinnedContext: AutomationProjectionContext = {
  ...context,
  workspaceHost: () => ({ kind: 'ssh', targetId: 'ssh-1' })
}

function expectConflict(run: () => void, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }))
}

describe('assertAutomationOwnerFence', () => {
  it('passes when the captured owner still matches', () => {
    expect(() =>
      assertAutomationOwnerFence({
        automation: sshRecord,
        expectedOwner: {
          selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 }
        },
        operation: 'mutate',
        context
      })
    ).not.toThrow()
  })

  it('fails closed on a stale SSH generation', () => {
    expectConflict(
      () =>
        assertAutomationOwnerFence({
          automation: sshRecord,
          expectedOwner: {
            selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 }
          },
          operation: 'mutate',
          context
        }),
      AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    )
  })

  it('fails closed when the expected host is a different target', () => {
    expectConflict(
      () =>
        assertAutomationOwnerFence({
          automation: sshRecord,
          expectedOwner: {
            selector: { kind: 'ssh', targetId: 'ssh-2', targetGeneration: 7 }
          },
          operation: 'mutate',
          context
        }),
      AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    )
  })

  // Optional on the wire is not unenforced: a generation-bearing record refuses
  // an ownerless mutation, while a generation-less legacy row stays callable bare.
  it('refuses an ownerless mutation of a record that captured a generation', () => {
    expectConflict(
      () => assertAutomationOwnerFence({ automation: sshRecord, operation: 'mutate', context }),
      AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired
    )
  })

  it('keeps legacy mutations compatible on a generation-less SSH record', () => {
    const legacySshRecord = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      projectId: 'repo-ssh'
    })
    expect(() =>
      assertAutomationOwnerFence({ automation: legacySshRecord, operation: 'mutate', context })
    ).not.toThrow()
  })

  it('keeps legacy mutations compatible on a self record', () => {
    expect(() =>
      assertAutomationOwnerFence({ automation: automation(), operation: 'mutate', context })
    ).not.toThrow()
  })

  it('still lets an old client read that record', () => {
    expect(() =>
      assertAutomationOwnerFence({ automation: sshRecord, operation: 'read', context })
    ).not.toThrow()
  })

  it('leaves a legacy client unaffected on self records', () => {
    expect(() =>
      assertAutomationOwnerFence({ automation: automation(), operation: 'mutate', context })
    ).not.toThrow()
  })

  // The stored field is absent on a workspace-pinned record while the projection carries a
  // generation, so keying the demand off storage let precisely this population write unfenced.
  it('keeps legacy workspace-pinned mutations and execution compatible', () => {
    for (const operation of ['mutate', 'execute'] as const) {
      expect(() =>
        assertAutomationOwnerFence({
          automation: pinnedLocalRecord,
          operation,
          context: pinnedContext
        })
      ).not.toThrow()
    }
  })

  it('still lets an old client read a workspace-pinned record', () => {
    expect(() =>
      assertAutomationOwnerFence({
        automation: pinnedLocalRecord,
        operation: 'read',
        context: pinnedContext
      })
    ).not.toThrow()
  })

  it('accepts the projected owner as the precondition for a workspace-pinned record', () => {
    expect(() =>
      assertAutomationOwnerFence({
        automation: pinnedLocalRecord,
        expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } },
        operation: 'mutate',
        context: pinnedContext
      })
    ).not.toThrow()
  })

  it('rejects a self precondition against an SSH record', () => {
    expectConflict(
      () =>
        assertAutomationOwnerFence({
          automation: sshRecord,
          expectedOwner: { selector: { kind: 'self' } },
          operation: 'mutate',
          context
        }),
      AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    )
  })

  it('keeps orphan delete available but refuses to dispatch it', () => {
    const orphan = automation({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-gone',
      executionTargetGeneration: 4
    })
    expect(() =>
      assertAutomationOwnerFence({
        automation: orphan,
        expectedOwner: { selector: { kind: 'orphan' } },
        operation: 'mutate',
        context
      })
    ).not.toThrow()
    expect(() =>
      assertAutomationOwnerFence({ automation: orphan, operation: 'mutate', context })
    ).not.toThrow()
    expectConflict(
      () => assertAutomationOwnerFence({ automation: orphan, operation: 'execute', context }),
      AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved
    )
  })
})

describe('destination validation', () => {
  it('accepts an SSH destination whose registration still matches', () => {
    expect(() =>
      assertAutomationDestination(
        { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } },
        context
      )
    ).not.toThrow()
  })

  it('rejects a ghost or future same-id target', () => {
    expectConflict(
      () =>
        assertAutomationDestination(
          { selector: { kind: 'ssh', targetId: 'ssh-gone', targetGeneration: 1 } },
          context
        ),
      AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination
    )
    expectConflict(
      () =>
        assertAutomationDestination(
          { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 8 } },
          context
        ),
      AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination
    )
  })

  it('rejects a record that would land on a different host than the caller chose', () => {
    expectConflict(
      () =>
        assertExecutionTargetMatchesDestination(
          { executionTargetType: 'local', executionTargetId: 'local' },
          { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
        ),
      AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination
    )
    expect(() =>
      assertExecutionTargetMatchesDestination(
        {
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-1',
          executionTargetGeneration: 7
        },
        { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
      )
    ).not.toThrow()
  })

  // The stored fields say `local`, but the pin is where the run goes: reading storage let a
  // record dispatch sends over SSH land under a Self destination the user chose.
  it('refuses a self destination for a record its workspace pins to SSH', () => {
    expectConflict(
      () =>
        assertExecutionTargetMatchesDestination(
          {
            executionTargetType: 'local',
            executionTargetId: 'local',
            executionTargetGeneration: 7
          },
          { selector: { kind: 'self' } },
          { targetId: 'ssh-1', generation: 7 }
        ),
      AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination
    )
  })

  it('accepts the pinned host as the destination for that same record', () => {
    expect(() =>
      assertExecutionTargetMatchesDestination(
        {
          executionTargetType: 'local',
          executionTargetId: 'local',
          executionTargetGeneration: 7
        },
        { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } },
        { targetId: 'ssh-1', generation: 7 }
      )
    ).not.toThrow()
  })

  it('leaves an unpinned local record landing on self', () => {
    expect(() =>
      assertExecutionTargetMatchesDestination(
        { executionTargetType: 'local', executionTargetId: 'local' },
        { selector: { kind: 'self' } }
      )
    ).not.toThrow()
  })
})
