import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
// The paste is the window's, after readiness; this file pins only what starts the agent.
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: vi.fn(() => new Promise(() => {}))
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))

createTabsSliceMockApi()

const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

const WT = 'repo1::/tmp/feature'

beforeEach(() => {
  testStore.current = createTestStore()
  callRuntimeRpc.mockReset()
  callRuntimeRpc.mockReturnValue(new Promise(() => {}))
  testStore.current.getState().setActiveWorktree(WT)
})

function launchCodex(suppressStartupUpdatePrompt?: boolean) {
  return launchAgentInNewTab({
    requestId: 'request-1',
    agent: 'codex',
    worktreeId: WT,
    prompt: 'continue from the previous session',
    promptDelivery: 'submit-after-ready',
    ...(suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt } : {})
  })
}

// #18153: Codex's startup "Update now" exits before a handoff pasted after readiness can land.
describe('a launch that must not lose its context to a startup update', () => {
  it('asks the host, which builds the command on the default route, to skip the prompt', () => {
    launchCodex(true)

    const [, method, params] = callRuntimeRpc.mock.calls[0] ?? []
    expect(method).toBe('agent.launchReplay')
    expect(params).toMatchObject({ agent: 'codex', suppressStartupUpdatePrompt: true })
  })

  it('leaves an ordinary launch to Codex’s own update check', () => {
    launchCodex()

    expect(callRuntimeRpc.mock.calls[0]?.[2]).not.toHaveProperty('suppressStartupUpdatePrompt')
  })
})
