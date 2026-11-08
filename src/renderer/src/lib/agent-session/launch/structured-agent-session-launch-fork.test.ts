// @vitest-environment happy-dom
import type { AgentSessionWireRefusal } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture
} from './structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => cleanupCreateMessageFixture(restore))

const forkFrom = { sessionId: 'codex_source', throughItemId: 'item-reply-2' }

it('sends no fork to a host that does not advertise forks', async () => {
  mocks.exactSupport.mockResolvedValue(false)
  const launch = startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId: 'fork-action',
    executionHostId: 'local',
    forkFrom
  })
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'structured_agent_session_fork_unsupported'
  })
  expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(false)
})

const copiedReply = {
  sessionId: 'copied-chat',
  throughItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
}
function forkLaunch(requestId: string) {
  vi.useRealTimers()
  mocks.exactSupport.mockResolvedValue(true)
  mocks.inventory.mockResolvedValue([])
  return startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId,
    executionHostId: 'local',
    forkFrom: copiedReply
  })
}

// Recorded create replies from the host's fork source-admission and post-copy paths.
const missingOriginal = {
  ok: false,
  refusal: {
    code: 'agent_session_identity_required',
    details: { reason: 'recordMissing' },
    createAttemptRefusedBeforeCommit: true,
    message: 'Codex could not find this response in the original chat. Open it and fork from there.'
  }
} as const
const changedOriginal = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'savedConversationMissing' },
    message: 'Codex could not find this response in the original chat. Open it and fork from there.'
  }
} as const

function returnCreateRefusal(refusal: { ok: false; refusal: AgentSessionWireRefusal }) {
  mocks.call.mockImplementation(async (_target, method) => {
    if (method !== 'agentSession.create') {
      throw new Error('No destination published')
    }
    return refusal
  })
}

it('settles proven missing and rewound-original refusals without an unknown destination', async () => {
  returnCreateRefusal(missingOriginal)
  const missing = forkLaunch('missing-original')
  await expect(missing.launchResult).rejects.toMatchObject({
    code: 'agent_session_identity_required',
    refusal: { details: { reason: 'recordMissing' } }
  })
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', missing.sessionId)).toBe(
    'failed'
  )
  expect(missing.isVisibilityUnknown()).toBe(false)
  returnCreateRefusal({
    ...changedOriginal,
    refusal: { ...changedOriginal.refusal, createAttemptRefusedBeforeCommit: true }
  })
  const removed = forkLaunch('removed-original-reply')
  await expect(removed.launchResult).rejects.toMatchObject({
    code: 'agent_session_operation_invalid',
    refusal: { details: { reason: 'savedConversationMissing' } }
  })
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', removed.sessionId)).toBe(
    'failed'
  )
  expect(removed.isVisibilityUnknown()).toBe(false)
})

it('keeps a post-copy source refusal uncertain without source-admission proof', async () => {
  returnCreateRefusal(changedOriginal)
  const launch = forkLaunch('post-copy-source-change')
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'agent_session_operation_invalid'
  })
  expect(launch.isVisibilityUnknown()).toBe(true)
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
    'visibility-unknown'
  )
})

it('keeps an earlier lost create unknown when the retry proves the original is missing', async () => {
  returnCreateRefusal(missingOriginal)
  mocks.call.mockRejectedValueOnce(new Error('create reply lost'))
  const launch = forkLaunch('lost-before-source-refusal')
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'agent_session_identity_required'
  })
  expect(launch.isVisibilityUnknown()).toBe(true)
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
    'visibility-unknown'
  )
})
