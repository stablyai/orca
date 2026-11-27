import { beforeEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentSessionLaunchIntent } from './structured-agent-session-launch-intent'

// The host boundary is the stand-in: admission, capabilities, permission, the create request and the
// abandon bookkeeping are counted. The final envelope check and its two refusal branches run for real.
const host = vi.hoisted(() => ({ call: vi.fn(), abandon: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: host.call
}))
vi.mock('./structured-agent-session-launch-abandon', () => ({
  abandonStructuredAgentSessionLaunchIntent: host.abandon
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'admitted' })
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  supportsStructuredAgentSessionCreateMessage: async () => true,
  supportsStructuredAgentSessionCreateOptionsMode: async () => false,
  structuredAgentSessionHostSupports: async () => false
}))
vi.mock('../../../store/workspace-layout/frames/frame-drawn-chat-tab-placement', () => ({
  withFrameDrawnChatTabPlacement: (intent: StructuredAgentSessionLaunchIntent) => intent.params
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ checkAgentCliUpdates: () => {} }) }
}))

const { launchStructuredAgentSession } =
  await import('./structured-agent-session-launch-create-call')
const {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} = await import('./structured-agent-session-launch-errors')

beforeEach(() => {
  host.call.mockReset()
  host.abandon.mockReset()
})

const message = (path: string): StructuredAgentSessionFirstMessage => ({
  clientMessageId: 'first',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'see [Image #1]' },
      { type: 'image-ref', path }
    ]
  }
})

function intent(path: string): StructuredAgentSessionLaunchIntent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create call reads only these fields.
  return {
    sessionId: 'final-envelope',
    worktreeId: 'wt',
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'codex',
    createPrepared: true,
    params: structuredAgentSessionCreateParams({
      sessionId: 'final-envelope',
      worktree: 'id:wt',
      agent: 'codex',
      randomUuid: () => '00000000-0000-4000-8000-000000000000',
      now: 1_700_000_000_000,
      firstMessage: message(path)
    })
  } as StructuredAgentSessionLaunchIntent
}

// D12-07. The live final envelope meets the outbound policy: a first message naming a browser file is
// never issued. With no earlier attempt it is refused and the launch abandoned; with an earlier
// attempt's outcome unknown nothing different goes out under its id, and recovery keeps it.
it('issues no create whose final first message names a browser file', async () => {
  const browser = intent('orca-browser-file:final/shot.png')
  await expect(launchStructuredAgentSession(browser)).rejects.toBeInstanceOf(
    StructuredAgentSessionCreateRefusalError
  )
  expect(host.abandon).toHaveBeenCalledTimes(1)
  expect(host.call).not.toHaveBeenCalled()

  const unknown = intent('orca-browser-file:final/shot.png')
  await expect(launchStructuredAgentSession(unknown, undefined, true)).rejects.toBeInstanceOf(
    StructuredAgentSessionCreateUnknownOutcomeError
  )
  expect(host.abandon).toHaveBeenCalledTimes(1)
  expect(host.call).not.toHaveBeenCalled()
})

// The control: a first message naming a host upload is issued once, exactly as built.
it('issues a create whose first message may leave, once and unchanged', async () => {
  host.call.mockRejectedValue(new Error('stop after the request'))
  const sendable = intent('/host/agent-session-attachments/u/shot.png')

  await launchStructuredAgentSession(sendable).catch(() => {})

  const creates = host.call.mock.calls.filter((call) => call[1] === 'agentSession.create')
  expect(creates).toHaveLength(1)
  expect(creates[0][2]).toMatchObject({ firstMessage: sendable.params.firstMessage })
})
