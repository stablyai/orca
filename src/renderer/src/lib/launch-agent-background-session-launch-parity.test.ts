import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../shared/constants'
import {
  AUTOMATION_LAUNCH_CASES,
  AUTOMATION_PROMPT,
  automationPhoneTab,
  automationSpawnRequest,
  type AutomationLaunchCase
} from '../../../shared/launch-parity-automation-cases.test-fixture'
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  launchWorkspaceId
} from '../../../shared/launch-parity-window-request.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
// The stdin-after-start paste is pinned by launch-agent-background-session.test.ts.
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  subscribeToPtyExit: vi.fn(() => () => {})
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: vi.fn(() => () => {})
}))

const load = perClientLoader(async () => ({
  launch: await import('./launch-agent-background-session'),
  phone: await import('@/runtime/sync-runtime-graph/mobile-session-snapshots')
}))

/** Runs one automation in a local workspace. */
async function runAutomation(c: AutomationLaunchCase) {
  const modules = await load(c.client)
  const store = modules.createStore()
  holder.store = store
  store.setState(
    launchWorkspaceState(c.workspace, { ...getDefaultSettings('/home/alice'), ...c.settings })
  )
  const spawn = vi.fn(async (_request: Record<string, unknown>) => ({ id: 'pty-1' }))
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
  })
  await modules.launch.launchAgentBackgroundSession({
    agent: c.agent,
    worktreeId: launchWorkspaceId(c.workspace),
    prompt: AUTOMATION_PROMPT,
    // Automation dispatch always passes 'unknown'.
    launchSource: 'unknown',
    title: c.title
  })
  const phone = modules.phone.buildMobileSessionTabSnapshots(store.getState(), false)
  return { spawn, phone }
}

/** Swaps the random tab, leaf and token ids for the table's fixed ones. */
function withFixedIds(value: unknown): unknown {
  const text = JSON.stringify(value)
  const ids = [
    ...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g))
  ]
  const fixed = [LAUNCH_TAB_ID, LAUNCH_LEAF_ID, LAUNCH_TOKEN]
  return JSON.parse(ids.reduce((out, id, index) => out.replaceAll(id, fixed[index] ?? id), text))
}

// Pins main's current launch behaviour as the convergence parity baseline (row 5): the pty:spawn
// request a desktop automation sends and its phone tab. C7 replaces this producer.
describe('row 5: desktop automation pty:spawn request', () => {
  beforeAll(async () => {
    await load('darwin')
    await load('linux')
    await load('win32')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  it.each(AUTOMATION_LAUNCH_CASES)('$name', async (c) => {
    const { spawn, phone } = await runAutomation(c)
    expect(withFixedIds(spawn.mock.calls[0]?.[0])).toEqual(automationSpawnRequest(c))
    expect(
      phone.map(({ tabs }) =>
        tabs.map((tab) => ({
          title: tab.title,
          launchAgent: recordOf(tab).launchAgent,
          isActive: tab.isActive
        }))
      )
    ).toEqual([[automationPhoneTab(c)]])
  })
})

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : {}
}
