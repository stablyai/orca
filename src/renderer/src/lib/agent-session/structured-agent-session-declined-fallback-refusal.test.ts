// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as launchModule from './launch/structured-agent-session-launch-create-call'
import type * as admission from './launch/structured-agent-session-launch-admission'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { StructuredAgentSessionCreateRefusalError } from './launch/structured-agent-session-launch-errors'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredAgentSessionLaunchFailure,
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from './launch/structured-agent-session-launch-registry'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
const mocks = vi.hoisted(() => ({ toast: vi.fn(), launch: vi.fn() }))
vi.mock('./launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('sonner', () => ({ toast: { info: mocks.toast, error: mocks.toast } }))
vi.mock('../focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

// Installed once: the storage object keeps the method it first hands out.
const saves = vi.spyOn(Storage.prototype, 'setItem')
let main: TabsDrawnFromMain
beforeEach(async () => {
  vi.clearAllMocks()
  resetStructuredAgentLaunchRegistryForTests()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => main.close())

it.each([1, 10])(
  "puts a refused terminal fallback's advice on the failed chat, with no message and no save (x%i retained launches)",
  async (scale) => {
    const creation = Promise.withResolvers<never>()
    mocks.launch.mockReturnValue(creation.promise)
    const fallback = vi.fn((): admission.StructuredLaunchTerminal => {
      // Only what follows the terminal's refusal is counted.
      saves.mockClear()
      return { opened: false, refusal: 'Reconnect it.' }
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: adoptAgentSessionLaunchVerdict({
        requestId: 'action',
        route: 'structured-native-chat',
        agent: 'claude',
        worktreeId: 'wt-1',
        executionHostId: 'local',
        prompt: '',
        promptDelivery: 'draft'
      }),
      hooks: {},
      focusIntent: { request: vi.fn(), cancel: vi.fn() },
      onHostDeclined: fallback
    })
    const sessionId = launch?.tab?.entityId ?? ''
    const own = getStructuredLaunchStateBySessionId(sessionId)
    // Other launches whose records stay saved, such as earlier failures awaiting Retry.
    for (let index = 0; own && index < 20 * scale; index += 1) {
      const retained = `retained-${index}`
      setStructuredLaunchState({
        ...own,
        identity: retained,
        intent: { ...own.intent, sessionId: retained }
      })
    }
    await main.settle()
    creation.reject(new StructuredAgentSessionCreateRefusalError('no'))
    expect((await launch?.settlement)?.kind).toBe('failed')
    expect(fallback).toHaveBeenCalledOnce()
    expect(getStructuredAgentSessionLaunchFailure('wt-1', sessionId)?.causeText).toBe(
      "This workspace can't run a Claude chat. Reconnect it."
    )
    // The wording is not saved; the failure it explains was saved when it happened.
    expect(saves).not.toHaveBeenCalled()
    expect(getPersistedStructuredAgentLaunchRecord(sessionId)?.lifecycle).toBe('failed')
    expect(mocks.toast).not.toHaveBeenCalled()
  }
)
