// @vitest-environment happy-dom
import { mocks, launchIntent, publishIntent } from './structured-agent-session-launch.test-fixture'
import { expect, it } from 'vitest'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import type { StructuredAgentSessionForkSource } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'

it('replays one side-chat action but opens a new snapshot for a distinct action after a lost reply', async () => {
  const forkFrom = { sessionId: 'source', current: true, permission: 'inherit' } as const
  mocks.createIntent
    .mockImplementationOnce(() => ({
      ...launchIntent('workspace', 'child-1'),
      params: { ...launchIntent('workspace', 'child-1').params, forkFrom }
    }))
    .mockImplementationOnce(() => ({
      ...launchIntent('workspace', 'child-2'),
      params: { ...launchIntent('workspace', 'child-2').params, forkFrom }
    }))
  mocks.launch.mockRejectedValue(new Error('reply lost'))
  const first = startStructuredAgentLaunch('workspace', 'codex', {
    requestId: 'action-1',
    forkFrom
  })
  await expect(first.launchResult).rejects.toThrow('reply lost')
  expect(getStructuredAgentSessionLaunchLifecycle('workspace', first.sessionId)).toBe(
    'visibility-unknown'
  )
  const replay = startStructuredAgentLaunch('workspace', 'codex', {
    requestId: 'action-1',
    forkFrom
  })
  void replay.launchResult.catch(() => undefined)
  expect(replay.sessionId).toBe('child-1')
  const repeatedDuringRecovery = startStructuredAgentLaunch('workspace', 'codex', {
    requestId: 'action-1',
    forkFrom
  })
  void repeatedDuringRecovery.launchResult.catch(() => undefined)
  expect(repeatedDuringRecovery.sessionId).toBe('child-1')
  const next = startStructuredAgentLaunch('workspace', 'codex', { requestId: 'action-2', forkFrom })
  void next.launchResult.catch(() => undefined)
  expect(next.sessionId).toBe('child-2')
  await expect(next.launchResult).rejects.toThrow('reply lost')
})

it('coalesces concurrent re-delivery of one current-fork action while preserving separate actions', async () => {
  const forkFrom: StructuredAgentSessionForkSource = {
    sessionId: 'source',
    current: true,
    permission: 'inherit'
  }
  const firstReply = Promise.withResolvers<{ sessionId: string; fence: number }>()
  const intent = {
    ...launchIntent('workspace', 'pending-child'),
    params: { ...launchIntent('workspace', 'pending-child').params, forkFrom }
  }
  mocks.createIntent.mockReturnValueOnce(intent)
  publishIntent(intent)
  mocks.launch.mockReturnValue(firstReply.promise)
  const first = startStructuredAgentLaunch('workspace', 'codex', {
    requestId: 'same-action',
    forkFrom
  })
  const repeat = startStructuredAgentLaunch('workspace', 'codex', {
    requestId: 'same-action',
    forkFrom
  })
  expect(repeat.sessionId).toBe('pending-child')
  firstReply.resolve({ sessionId: 'pending-child', fence: 1 })
  await Promise.all([first.launchResult, repeat.launchResult])
})
