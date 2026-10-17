import { afterEach, describe, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { splitWebRuntimeTerminal } from './web-runtime-terminal-actions'
import {
  ENVIRONMENT_ID,
  SPLIT_SOURCE_PTY_ID,
  makeSplitSourceState
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

const SSH_TARGET_ID = 'ssh-target-1'

type RuntimeCallRequest = { method: string; params: Record<string, unknown> }
type RuntimeCallMock = ReturnType<typeof vi.fn<(request: RuntimeCallRequest) => Promise<unknown>>>

function splitSourceState(sshTargetId?: string): Record<string, unknown> {
  return makeSplitSourceState({ hostTabId: 'tab-1', ...(sshTargetId ? { sshTargetId } : {}) })
}

function stubSplit(proxyTarget: Record<string, unknown>): RuntimeCallMock {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 7 }])
  const runtimeCall = vi.fn<(request: RuntimeCallRequest) => Promise<unknown>>().mockResolvedValue({
    id: 'split',
    ok: true,
    result: { split: { handle: 'terminal-2', tabId: 'tab-1', paneRuntimeId: -1 } }
  })
  vi.stubGlobal('window', {
    api: {
      ssh: { listTargets: async () => [proxyTarget] },
      runtimeEnvironments: { call: runtimeCall }
    }
  })
  return runtimeCall
}

async function splitCallParams(runtimeCall: RuntimeCallMock): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.split')).toBe(
      true
    )
  )
  const splitCall = runtimeCall.mock.calls.find(([request]) => request.method === 'terminal.split')
  if (!splitCall) {
    throw new Error('terminal.split was never sent')
  }
  const [request] = splitCall
  return request.params
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

describe('splitWebRuntimeTerminal host proxy env', () => {
  it('sends the SSH host own proxy env with the host split', async () => {
    mocks.getState.mockReturnValue(splitSourceState(SSH_TARGET_ID))
    const runtimeCall = stubSplit({
      id: SSH_TARGET_ID,
      httpProxyUrl: 'http://proxy.test:3128',
      httpProxyBypassRules: 'localhost'
    })

    expect(splitWebRuntimeTerminal(SPLIT_SOURCE_PTY_ID, 'horizontal', 'keyboard')).toBe(true)

    await expect(splitCallParams(runtimeCall)).resolves.toMatchObject({
      terminal: 'terminal-1',
      direction: 'horizontal',
      telemetrySource: 'keyboard',
      env: {
        HTTP_PROXY: 'http://proxy.test:3128',
        HTTPS_PROXY: 'http://proxy.test:3128',
        ALL_PROXY: 'http://proxy.test:3128',
        NO_PROXY: 'localhost',
        no_proxy: 'localhost'
      }
    })
  })

  it('omits the env for a host with no proxy of its own', async () => {
    mocks.getState.mockReturnValue(splitSourceState(SSH_TARGET_ID))
    const runtimeCall = stubSplit({ id: SSH_TARGET_ID })

    expect(splitWebRuntimeTerminal(SPLIT_SOURCE_PTY_ID, 'horizontal', 'keyboard')).toBe(true)

    await expect(splitCallParams(runtimeCall)).resolves.not.toHaveProperty('env')
  })
})
