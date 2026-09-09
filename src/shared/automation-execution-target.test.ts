import { describe, expect, it } from 'vitest'
import {
  MISSING_AUTOMATION_PROJECT_ERROR,
  applyAutomationExecutionTarget,
  deriveAutomationExecutionTargetForCreate,
  deriveAutomationExecutionTargetForUpdate,
  type AutomationStoredExecutionTarget
} from './automation-execution-target'

const storedSsh: AutomationStoredExecutionTarget = {
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-1',
  executionTargetGeneration: 4
}

/** SSH-owned through its folder workspace, not through its project. */
const storedPinnedLocal: AutomationStoredExecutionTarget = {
  executionTargetType: 'local',
  executionTargetId: 'local',
  executionTargetGeneration: 4
}

describe('deriveAutomationExecutionTargetForCreate', () => {
  it('fails closed when the project does not resolve', () => {
    expect(() =>
      deriveAutomationExecutionTargetForCreate({ repo: undefined, sshTargetGeneration: undefined })
    ).toThrow(MISSING_AUTOMATION_PROJECT_ERROR)
  })

  it('stores the current registration generation for an SSH project', () => {
    expect(
      deriveAutomationExecutionTargetForCreate({
        repo: { connectionId: 'ssh-1' },
        sshTargetGeneration: 4
      })
    ).toEqual({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1',
      executionTargetGeneration: 4
    })
  })

  it('omits the generation for a local project', () => {
    expect(
      deriveAutomationExecutionTargetForCreate({
        repo: { connectionId: null },
        sshTargetGeneration: 9
      })
    ).toEqual({ executionTargetType: 'local', executionTargetId: 'local' })
  })

  it('captures the pinned registration for a local project whose workspace runs on SSH', () => {
    expect(
      deriveAutomationExecutionTargetForCreate({
        repo: { connectionId: null },
        sshTargetGeneration: undefined,
        workspaceSshPin: { targetId: 'ssh-1', generation: 4 }
      })
    ).toEqual({
      executionTargetType: 'local',
      executionTargetId: 'local',
      executionTargetGeneration: 4
    })
  })
})

describe('deriveAutomationExecutionTargetForUpdate', () => {
  it('preserves the stored SSH selector when the owning project was deleted', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedSsh,
        repo: undefined,
        selectorMoveRequested: false,
        sshTargetGeneration: undefined
      })
    ).toEqual(storedSsh)
  })

  // The repo resolving is not consent: this is the pause-an-orphan path.
  it('preserves the stored selector when the resolved project points somewhere else', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedSsh,
        repo: { connectionId: 'ssh-2' },
        selectorMoveRequested: false,
        sshTargetGeneration: 11
      })
    ).toEqual(storedSsh)
  })

  it('keeps a captured generation the current target no longer has', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedSsh,
        repo: { connectionId: 'ssh-1' },
        selectorMoveRequested: false,
        sshTargetGeneration: undefined
      })
    ).toEqual(storedSsh)
  })

  it('throws when a requested move has no resolvable project', () => {
    expect(() =>
      deriveAutomationExecutionTargetForUpdate({
        current: storedSsh,
        repo: undefined,
        selectorMoveRequested: true,
        sshTargetGeneration: undefined
      })
    ).toThrow(MISSING_AUTOMATION_PROJECT_ERROR)
  })

  it('re-derives from a resolved project once a move is requested', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedSsh,
        repo: { connectionId: 'ssh-2' },
        selectorMoveRequested: true,
        sshTargetGeneration: 11
      })
    ).toEqual({
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-2',
      executionTargetGeneration: 11
    })
  })

  it('captures the new pin when the update re-points the record at another workspace', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedPinnedLocal,
        repo: { connectionId: null },
        selectorMoveRequested: false,
        sshTargetGeneration: undefined,
        workspaceSshPin: { targetId: 'ssh-2', generation: 11 },
        workspaceSshPinMoved: true
      })
    ).toEqual({
      executionTargetType: 'local',
      executionTargetId: 'local',
      executionTargetGeneration: 11
    })
  })

  it('drops the capture when the update leaves the record unpinned', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedPinnedLocal,
        repo: { connectionId: null },
        selectorMoveRequested: false,
        sshTargetGeneration: undefined,
        workspaceSshPin: undefined,
        workspaceSshPinMoved: true
      })
    ).toEqual({ executionTargetType: 'local', executionTargetId: 'local' })
  })

  it('keeps the capture while the pin is unchanged', () => {
    expect(
      deriveAutomationExecutionTargetForUpdate({
        current: storedPinnedLocal,
        repo: { connectionId: null },
        selectorMoveRequested: false,
        sshTargetGeneration: undefined,
        workspaceSshPin: { targetId: 'ssh-1', generation: 4 },
        workspaceSshPinMoved: false
      })
    ).toEqual(storedPinnedLocal)
  })
})

describe('applyAutomationExecutionTarget', () => {
  it('clears a stale generation when the record moves off SSH', () => {
    const next = applyAutomationExecutionTarget(
      { ...storedSsh, name: 'keep me' },
      { executionTargetType: 'local', executionTargetId: 'local' }
    )
    expect(next).toEqual({
      executionTargetType: 'local',
      executionTargetId: 'local',
      name: 'keep me'
    })
    expect(Object.hasOwn(next, 'executionTargetGeneration')).toBe(false)
  })

  // Losing it here is what made a same-id re-registration read as the host the user chose.
  it('keeps the capture when the destination is still pinned to the same SSH target', () => {
    const next = applyAutomationExecutionTarget(
      { ...storedPinnedLocal, name: 'keep me' },
      { executionTargetType: 'local', executionTargetId: 'local' },
      { targetId: 'ssh-1', generation: undefined }
    )
    expect(next.executionTargetGeneration).toBe(4)
  })
})
