import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimeAgentPrompt } from './runtime-terminal-agent-prompt'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { useAppStore } from '../store'

describe('paired Web agent prompts', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const runtimeTransportSubscribe = vi.fn()
  const localWrite = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 12 } },
      _meta: { runtimeId: 'runtime-1' }
    })
    runtimeTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
    })
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: false,
      location: { pathname: '' },
      api: {
        runtimeEnvironments: {
          call: runtimeTransportCall,
          subscribe: runtimeTransportSubscribe
        },
        pty: {
          write: localWrite
        }
      }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true },
      terminalLayoutsByTabId: {},
      lastTerminalInputAtByPaneKey: {},
      runtimeStatusByEnvironmentId: new Map()
    })
  })

  it('submits a complete remote Agent prompt through one semantic RPC', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test flag is a window global the Web client detector reads and the DOM lib does not declare.
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store fixture only needs the capability list the semantic-prompt probe reads.
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
            status: { capabilities: ['client-surface.web.v1'] }
          }
        ]
      ]) as never
    })
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 12 } },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      sendRuntimeAgentPrompt(
        { activeRuntimeEnvironmentId: 'env-2' },
        'remote:env-1@@terminal-1',
        'edited draft'
      )
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: 'edited draft',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      timeoutMs: 15_000
    })
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('cancels an in-flight semantic Agent prompt through the runtime transport', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test flag is a window global the Web client detector reads and the DOM lib does not declare.
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store fixture only needs the capability list the semantic-prompt probe reads.
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
            status: { capabilities: ['client-surface.web.v1'] }
          }
        ]
      ]) as never
    })
    const unsubscribe = vi.fn()
    runtimeTransportSubscribe.mockResolvedValue({ unsubscribe, sendBinary: vi.fn() })
    const controller = new AbortController()

    const submission = sendRuntimeAgentPrompt(
      { activeRuntimeEnvironmentId: 'env-2' },
      'remote:env-1@@terminal-1',
      'cancelled draft',
      controller.signal
    )
    expect(submission).not.toBeNull()
    await vi.waitFor(() => expect(runtimeTransportSubscribe).toHaveBeenCalledOnce())

    controller.abort()

    await expect(submission).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  })

  it('leaves local and direct SSH Agent prompts on the existing byte path', () => {
    expect(sendRuntimeAgentPrompt(null, 'local-pty', 'hello')).toBeNull()
    expect(sendRuntimeAgentPrompt(null, 'ssh:host@@pty-1', 'hello')).toBeNull()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('keeps a new client on raw framing when the owning Runtime predates semantic prompts', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test flag is a window global the Web client detector reads and the DOM lib does not declare.
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store fixture only needs the empty capability list the semantic-prompt probe reads.
      runtimeStatusByEnvironmentId: new Map([['env-1', { status: { capabilities: [] } }]]) as never
    })

    expect(sendRuntimeAgentPrompt(null, 'remote:env-1@@terminal-1', 'multiline\nprompt')).toBeNull()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('keeps Electron clients on their existing byte framing even with a capable Runtime', () => {
    useAppStore.setState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store fixture only needs the capability list the semantic-prompt probe reads.
      runtimeStatusByEnvironmentId: new Map([
        ['env-1', { status: { capabilities: ['client-surface.web.v1'] } }]
      ]) as never
    })

    expect(sendRuntimeAgentPrompt(null, 'remote:env-1@@terminal-1', 'desktop prompt')).toBeNull()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
