import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-persistence'
import {
  createStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession,
  restoreStructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import { admitStructuredLaunchOnHost } from './structured-agent-session-host-admission'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

const CLIENT_OPTIONS = { model: 'sonnet', effort: 'high', fastMode: 'true', permissionMode: 'ask' }
const HOST_OPTIONS = { model: 'opus', effort: 'low', fastMode: 'false', permissionMode: 'bypass' }
const initialSettings = useAppStore.getState().settings

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...initialSettings!,
      nativeChatPermissionMode: 'ask',
      nativeChatSessionOptions: {
        claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'high', fastMode: true } } }
      }
    }
  })
  vi.mocked(callStructuredAgentSession).mockReset()
})
afterEach(() => useAppStore.setState({ settings: initialSettings }))

function respondingHost(acceptsClientOptions: boolean) {
  vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
    method === 'agentSession.createSupport'
      ? {
          supported: true,
          seedOptions: HOST_OPTIONS,
          ...(acceptsClientOptions ? { acceptsClientOptions: true } : {})
        }
      : { ok: true, value: { sessionId: 'claude_chat', fence: 1 } }
  )
}

describe('client-owned new-chat choices', () => {
  it('shows and sends the client choices when SSH host defaults disagree', async () => {
    respondingHost(true)
    const admission = await admitStructuredLaunchOnHost(
      { kind: 'environment', environmentId: 'server' },
      'id:folder',
      'claude'
    )
    expect(admission).toEqual({
      kind: 'admitted',
      seedOptions: CLIENT_OPTIONS,
      clientOptions: CLIENT_OPTIONS
    })
    const intent = createStructuredAgentSessionLaunchIntent(
      'folder',
      'claude',
      'runtime:server',
      undefined,
      admission.kind === 'admitted' ? admission.seedOptions : undefined,
      admission.kind === 'admitted' ? admission.clientOptions : undefined
    )
    expect(intent.seedOptions).toEqual(CLIENT_OPTIONS)
    const shown = vi.fn()
    await launchStructuredAgentSession(intent, shown)
    expect(shown).toHaveBeenLastCalledWith(CLIENT_OPTIONS)
    expect(callStructuredAgentSession).toHaveBeenLastCalledWith(
      intent.target,
      'agentSession.create',
      expect.objectContaining({ options: CLIENT_OPTIONS })
    )
    expect(intent.params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: intent.sessionId, ...intent.params })
    )
  })

  it('keeps old-host picker values and omits unsupported fields', async () => {
    respondingHost(false)
    const admission = await admitStructuredLaunchOnHost(
      { kind: 'environment', environmentId: 'server' },
      'id:folder',
      'claude'
    )
    expect(admission).toEqual({ kind: 'admitted', seedOptions: HOST_OPTIONS })
    const intent = createStructuredAgentSessionLaunchIntent(
      'folder',
      'claude',
      'runtime:server',
      undefined,
      HOST_OPTIONS
    )
    const shown = vi.fn()
    await launchStructuredAgentSession(intent, shown)
    expect(shown).toHaveBeenLastCalledWith(HOST_OPTIONS)
    expect(intent.params).not.toHaveProperty('options')
  })

  it('includes pre-create composer picks and replays the exact selection after settings change', async () => {
    respondingHost(true)
    const intent = createStructuredAgentSessionLaunchIntent('folder', 'claude', 'runtime:server')
    const held = { model: 'haiku', permissionMode: 'accept-edits' }
    await launchStructuredAgentSession(intent, undefined, () => held)
    expect(intent.params.options).toEqual(held)
    const record = structuredAgentLaunchRecordFor(intent, 'visibility-unknown')
    useAppStore.setState({ settings: { ...initialSettings!, nativeChatPermissionMode: 'bypass' } })
    const restored = restoreStructuredAgentSessionLaunchIntent({ ...record, worktreeId: 'folder' })
    expect(restored.params).toEqual(intent.params)
    expect(restored.seedOptions).toEqual(held)
    await launchStructuredAgentSession(restored)
    expect(restored.params).toEqual(intent.params)
  })

  it('uses no host model when the client has never picked one', async () => {
    respondingHost(true)
    useAppStore.setState({
      settings: {
        ...initialSettings!,
        nativeChatPermissionMode: 'ask',
        nativeChatSessionOptions: {}
      }
    })
    const intent = createStructuredAgentSessionLaunchIntent('folder', 'claude', 'runtime:server')
    await launchStructuredAgentSession(intent)
    expect(intent.params.options).toEqual({ permissionMode: 'ask' })
  })
})
