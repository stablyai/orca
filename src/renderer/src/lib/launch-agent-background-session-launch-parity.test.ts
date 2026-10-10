import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import { AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer-fixture'
import {
  AUTOMATION_LAUNCH_CASES,
  AUTOMATION_PROMPT,
  automationPhoneTab,
  automationSpawnRequest,
  type AutomationLaunchCase
} from '../../../shared/launch-parity-automation-cases.test-fixture'
import {
  PAIRED_AUTOMATION_CASES,
  PAIRED_AUTOMATION_WORKSPACE,
  pairedAgentSessionParams,
  pairedLegacyCreateParams,
  type PairedAutomationCase
} from '../../../shared/launch-parity-paired-host.test-fixture'
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  launchWorkspaceId
} from '../../../shared/launch-parity-window-request.test-fixture'

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer-fixture')).launchStoreModuleMock(holder)
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
  rpc: await import('@/runtime/runtime-rpc-client'),
  multiplexer: await import('@/runtime/remote-runtime-terminal-multiplexer')
}))

type Paired = { removed: readonly string[]; failCreateAgentSession?: string }

/** Runs one automation; `paired` routes the workspace to paired runtime env-1 instead. */
async function runAutomation(
  c: Pick<AutomationLaunchCase, 'client' | 'workspace' | 'settings' | 'agent' | 'title'>,
  paired?: Paired
) {
  const modules = await load(c.client)
  modules.rpc.clearRuntimeCompatibilityCacheForTests()
  modules.multiplexer.resetRemoteRuntimeTerminalMultiplexersForTests()
  const store = modules.createStore()
  holder.store = store
  store.setState(launchWorkspaceState(c.workspace, c.settings))
  const spawn = vi.fn(async (_request: Record<string, unknown>) => ({ id: 'pty-1' }))
  const rpc = vi.fn(async (request: { method: string }) =>
    request.method === 'terminal.createAgentSession' && paired?.failCreateAgentSession
      ? { ok: false, error: { code: paired.failCreateAgentSession, message: 'legacy' } }
      : { ok: true, result: { terminal: { handle: 'terminal-1', worktreeId: 'wt', title: null } } }
  )
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: {
      pty: { spawn, write: vi.fn(), kill: vi.fn() },
      runtime: { call: vi.fn() },
      runtimeEnvironments: {
        // The paired host answers status.get without the capabilities a case withholds.
        call: async (request: { method: string }) => {
          const status = createCompatibleRuntimeStatusResponseIfNeeded(request)
          if (!status?.ok) {
            return rpc(request)
          }
          const capabilities = status.result.capabilities?.filter(
            (capability) => !paired?.removed.includes(capability)
          )
          return { ...status, result: { ...status.result, capabilities } }
        },
        subscribe: async (_request: unknown, callbacks: { onResponse: (r: unknown) => void }) => {
          queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
          return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
        }
      }
    }
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
  return { spawn, rpc, phone }
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

// Pins main's current launch behaviour as the convergence parity baseline (row 5, rule
// AUTOMATION_WSL_EXE): the pty:spawn request a desktop automation sends and its phone tab.
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

const KEYBOARD = AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
const pairedRun = (c: PairedAutomationCase) => ({
  ...c,
  title: 'Nightly audit run 3',
  workspace: PAIRED_AUTOMATION_WORKSPACE
})

function onlyCreate(rpc: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  const creates = rpc.mock.calls.map(([request]) => request).filter((r) => r.method === method)
  expect(creates).toHaveLength(1)
  expect({ selector: creates[0].selector, timeoutMs: creates[0].timeoutMs }).toEqual({
    selector: 'env-1',
    timeoutMs: 15_000
  })
  return creates[0].params
}

// Pins main's current launch behaviour as the convergence parity baseline (row 5r, host-authority
// path): the terminal.createAgentSession params an automation sends a paired runtime.
describe('row 5r: paired runtime terminal.createAgentSession params', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(PAIRED_AUTOMATION_CASES.filter((c) => c.client === 'linux'))('$name', async (c) => {
    const { spawn, rpc } = await runAutomation(pairedRun(c), {
      removed: c.keyboard ? [] : [KEYBOARD]
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(withFixedIds(onlyCreate(rpc, 'terminal.createAgentSession'))).toEqual({
      ...pairedAgentSessionParams(c),
      clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/)
    })
  })
})

// Pins main's current launch behaviour as the convergence parity baseline (row 5r, legacy path):
// the verbatim window plan terminal.create sends a host without agent-session host authority.
describe('row 5r: paired runtime legacy terminal.create params', () => {
  afterEach(() => vi.unstubAllGlobals())
  const LEGACY = [AGENT_SESSION_HOST_AUTHORITY_CAPABILITY, KEYBOARD]

  it.each(PAIRED_AUTOMATION_CASES.filter((c) => c.keyboard))('$name', async (c) => {
    const { spawn, rpc } = await runAutomation(pairedRun(c), { removed: LEGACY })
    expect(spawn).not.toHaveBeenCalled()
    expect(withFixedIds(onlyCreate(rpc, 'terminal.create'))).toEqual(pairedLegacyCreateParams(c))
  })

  it.each(['agent_session_legacy_required', 'method_not_found'])(
    'falls back to terminal.create once the host answers %s',
    async (code) => {
      const { rpc } = await runAutomation(pairedRun(PAIRED_AUTOMATION_CASES[0]), {
        removed: [],
        failCreateAgentSession: code
      })
      expect(rpc.mock.calls.map(([request]) => request.method).slice(0, 2)).toEqual([
        'terminal.createAgentSession',
        'terminal.create'
      ])
    }
  )
})

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : {}
}
