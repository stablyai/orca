import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../../shared/bundled-skill-plan'
import { bundledSkillTargetKey } from '@/lib/bundled-skill-target'
import { executeBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'
import { consumeSkillFreshnessUpdateDialogRequest } from './skill-freshness-update-dialog'
import {
  _resetSkillUpdateRunStore,
  getSkillUpdateRun,
  SKILL_UPDATE_SUCCESS_LINGER_MS,
  startSkillUpdateRun
} from './skill-update-run-store'

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  executeBundledSkillsOnTarget: vi.fn()
}))

const LOCAL = { kind: 'local' } as const
const SERVER = { kind: 'environment', environmentId: 'server-1' } as const

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  _resetSkillUpdateRunStore()
  consumeSkillFreshnessUpdateDialogRequest()
})

afterEach(() => {
  _resetSkillUpdateRunStore()
  vi.useRealTimers()
})

describe('skill update runs by target', () => {
  it.each([false, true])(
    'keeps attention and result counts on their own host (remote attention: %s)',
    async (remoteAttention) => {
      const attentionTarget = remoteAttention ? SERVER : LOCAL
      const successTarget = remoteAttention ? LOCAL : SERVER
      const attentionKey = bundledSkillTargetKey(attentionTarget)
      const successKey = bundledSkillTargetKey(successTarget)
      const attentionResult: BundledSkillInstallResult = {
        scope: 'global',
        skills: [
          {
            name: 'orca-cli',
            status: 'ran',
            ops: [{ path: '/skills/orca-cli', kind: 'restore', status: 'done' }]
          }
        ]
      }
      const successResult: BundledSkillInstallResult = {
        scope: 'global',
        skills: [
          {
            name: 'orchestration',
            status: 'ran',
            ops: [{ path: '/skills/orchestration', kind: 'update', status: 'done' }]
          },
          {
            name: 'orca-linear',
            status: 'ran',
            ops: [{ path: '/skills/orca-linear', kind: 'leave', reason: 'edited', status: 'done' }]
          }
        ]
      }
      let settleAttention = (_result: BundledSkillInstallResult): void => {
        throw new Error('Attention run has not started')
      }
      vi.mocked(executeBundledSkillsOnTarget)
        .mockImplementationOnce(
          () =>
            new Promise<BundledSkillInstallResult>((resolve) => {
              settleAttention = resolve
            })
        )
        .mockResolvedValueOnce(successResult)

      const attentionRun = startSkillUpdateRun({
        target: attentionTarget,
        names: ['orca-cli'],
        planDigest: 'a'.repeat(64),
        force: []
      })
      await startSkillUpdateRun({
        target: successTarget,
        names: ['orchestration', 'orca-linear'],
        planDigest: 'b'.repeat(64),
        force: []
      })
      expect(getSkillUpdateRun(attentionKey)).toMatchObject({
        state: 'running',
        targetKey: attentionKey
      })
      settleAttention(attentionResult)
      await attentionRun

      expect(executeBundledSkillsOnTarget).toHaveBeenNthCalledWith(
        1,
        attentionTarget,
        'a'.repeat(64),
        { force: [] }
      )
      expect(executeBundledSkillsOnTarget).toHaveBeenNthCalledWith(
        2,
        successTarget,
        'b'.repeat(64),
        { force: [] }
      )
      expect(getSkillUpdateRun(attentionKey)).toMatchObject({
        state: 'done',
        targetKey: attentionKey,
        needsAttention: true,
        summary: { ok: true, changedCount: 0, leftAloneCount: 0 }
      })
      expect(getSkillUpdateRun(successKey)).toMatchObject({
        state: 'done',
        targetKey: successKey,
        needsAttention: false,
        summary: { ok: true, changedCount: 1, leftAloneCount: 1 }
      })

      vi.advanceTimersByTime(SKILL_UPDATE_SUCCESS_LINGER_MS)

      expect(getSkillUpdateRun(successKey).state).toBe('idle')
      expect(getSkillUpdateRun(attentionKey).state).toBe('done')
    }
  )
})
