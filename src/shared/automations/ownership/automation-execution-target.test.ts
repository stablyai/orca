import { describe, expect, it } from 'vitest'
import {
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
})

describe('applyAutomationExecutionTarget', () => {
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
