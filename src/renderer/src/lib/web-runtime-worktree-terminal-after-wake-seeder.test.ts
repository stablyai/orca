// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/runtime/hosted-terminals/restoration/web-runtime-worktree-terminal-after-wake'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/hosted-terminals/restoration/web-runtime-wake-terminal-respawn'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  isWebRuntimeInitialTerminalBootstrapInFlight,
  releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame,
  resetWebRuntimeInitialTerminalBootstrapForTests
} from '@/runtime/web-session-tabs-sync/initial-terminal/web-runtime-initial-terminal-bootstrap'

const mocks = vi.hoisted(
  (): { create: ReturnType<typeof vi.fn>; tabsByWorktree: Record<string, unknown[]> } => ({
    create: vi.fn(),
    tabsByWorktree: {}
  })
)
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.create
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'host'
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: () => ({ id: 'wt' }),
      tabsByWorktree: mocks.tabsByWorktree,
      ptyIdsByTabId: {}
    })
  }
}))

const startup = { command: "claude 'fix it'", launchAgent: 'claude' as const }

afterEach(() => {
  vi.clearAllMocks()
  mocks.tabsByWorktree = {}
  resetWebRuntimeWakeTerminalRespawnForTests()
  resetWebRuntimeInitialTerminalBootstrapForTests()
})

it('holds the session-tabs seeder off while the create’s startup terminal is made (GA-P3t)', async () => {
  const pending = Promise.withResolvers<{ status: 'created' }>()
  mocks.create.mockReturnValue(pending.promise)
  expect(ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude' })).toBe(true)
  // An empty first host answer now finds the bootstrap claimed: no second, plain terminal.
  expect(isWebRuntimeInitialTerminalBootstrapInFlight('host', 'wt')).toBe(true)
  expect(beginWebRuntimeInitialTerminalBootstrap('host', 'wt')).toBe(false)
  pending.resolve({ status: 'created' })
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
  await pending.promise
  await Promise.resolve()
  // Created but not mirrored yet: still held until the host lists it.
  expect(isWebRuntimeInitialTerminalBootstrapInFlight('host', 'wt')).toBe(true)
  releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame('host', 'wt')
  expect(isWebRuntimeInitialTerminalBootstrapInFlight('host', 'wt')).toBe(false)
})

it('releases the seeder at once when the create fails, so the workspace still gets a terminal', async () => {
  mocks.create.mockResolvedValue({ status: 'failed', message: 'no host' })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude' })
  await vi.waitFor(() =>
    expect(isWebRuntimeInitialTerminalBootstrapInFlight('host', 'wt')).toBe(false)
  )
})

it('releases at once when the host row is already mirrored', async () => {
  mocks.create.mockImplementation(async () => {
    mocks.tabsByWorktree = { wt: [] }
    return { status: 'created' }
  })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude' })
  await vi.waitFor(() =>
    expect(isWebRuntimeInitialTerminalBootstrapInFlight('host', 'wt')).toBe(false)
  )
})
