import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as TransportFixtureModule from '@/runtime/layout-apply-test-transport.test-fixture'
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

// Main's answer to the window's layout commands, as a switch-on build sends them. The mocked
// client outlives each client's module reset, so its transport is kept here.
type TransportFixture = typeof TransportFixtureModule
const main = vi.hoisted((): { transport: TransportFixture['layoutApplyTestTransport'] | null } => ({
  transport: null
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const fixture = await import('@/runtime/layout-apply-test-transport.test-fixture')
  main.transport = fixture.layoutApplyTestTransport
  return fixture.runtimeRpcClientWithLayoutApply(await importOriginal())
})

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
  phone: await import('@/runtime/sync-runtime-graph/mobile-session-snapshots'),
  switch: await import('../../../shared/layout-owner-switch')
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
  if (modules.switch.ORCA_LAYOUT_OWNER_IS_MAIN) {
    // Main takes the run title by tab-bar id, and its frame (not modelled here) draws it.
    const tabBarId = store.getState().unifiedTabsByWorktree[launchWorkspaceId(c.workspace)]![0]!.id
    expect(main.transport?.sentOfType('renameTab').at(-1)).toEqual(
      expect.objectContaining({ tabId: tabBarId, kind: 'custom', title: c.title })
    )
    for (const snapshot of phone) {
      snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, title: c.title }))
    }
  }
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
