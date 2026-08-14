import { beforeAll, describe, expect, it, vi } from 'vitest'

// Why these three: `main/ipc/pty.ts` and `main/runtime/orca-runtime.ts` are real
// production modules here, so their Electron/native edges need stand-ins. Nothing
// on the decision path under test is mocked.
vi.mock('electron', () => ({
  BrowserWindow: undefined,
  app: { isPackaged: true, getPath: () => '/tmp/orca-user-data', getVersion: () => '0.0.0-test' },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('psl', () => ({ parse: () => ({ domain: null }) }))

const { resolveBaselineReleaseRef } = await import('./release-checkout')
const { driveHostRecoveryAuthorization, SKEW_HOST_PANE } =
  await import('./reattach-recovery-authorization-skew')
const { loadTerminalWireBuild, WORKING_TREE } = await import('./versioned-terminal-wire')
type TerminalWireBuild = Awaited<ReturnType<typeof loadTerminalWireBuild>>
type Outcome = Awaited<ReturnType<typeof driveHostRecoveryAuthorization>>

const SUITE_TIMEOUT_MS = 180_000

let current: TerminalWireBuild
let baseline: TerminalWireBuild
let currentHost: Outcome
let baselineHost: Outcome
let currentHostAppIdSpace: Outcome
let baselineHostAppIdSpace: Outcome

beforeAll(async () => {
  current = await loadTerminalWireBuild(WORKING_TREE)
  baseline = await loadTerminalWireBuild(resolveBaselineReleaseRef())
  // Serial on purpose: `ipc/pty.ts` keeps module-level provider state per build.
  currentHost = await driveHostRecoveryAuthorization({
    hostBuild: current,
    runtimePtyIdSpace: 'relay'
  })
  baselineHost = await driveHostRecoveryAuthorization({
    hostBuild: baseline,
    runtimePtyIdSpace: 'relay'
  })
  currentHostAppIdSpace = await driveHostRecoveryAuthorization({
    hostBuild: current,
    runtimePtyIdSpace: 'app'
  })
  baselineHostAppIdSpace = await driveHostRecoveryAuthorization({
    hostBuild: baseline,
    runtimePtyIdSpace: 'app'
  })
}, SUITE_TIMEOUT_MS)

function expectDriveActuallyRan(outcome: Outcome): void {
  // The anti-vacuous-pass oracle: a host that never attached, never published a
  // failure, or never reached its recovery gate proves nothing about refusal.
  expect(outcome.attachedBeforeFault).toBe(true)
  expect(outcome.publishedFailure).not.toBe('')
  expect(outcome.recoverPaneOutcome).toMatch(/^(granted|refused)$/)
}

describe('cross-version reattach recovery authorization', () => {
  it(
    'skews a real published release against current code',
    () => {
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
      expect(currentHost.publishedFailure).not.toBe(baselineHost.publishedFailure)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the current host neither expires its own lease nor grants a replacement shell',
    () => {
      expectDriveActuallyRan(currentHost)
      // Rule 3 of remote-wire-compatibility: what the host publishes reaches old
      // clients with no wire change. Here the host also acts on it locally — and
      // a live shell whose output source must be restored is not an expiry, so
      // no durable state may be destroyed on its behalf.
      expect(currentHost.leaseWrites).toEqual([])
      expect(currentHost.leaseStateAfterFailure).toBe('attached')
      // Any client version may still ASK for a replacement. The host is what
      // must refuse, before the mutation.
      expect(currentHost.recoverPaneOutcome).toBe('refused')
      expect(currentHost.recoverPaneError).toContain('terminal_not_recoverable')
      expect(currentHost.replacementShellsCreated).toBe(0)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the current host refuses whichever id space the pane was registered under',
    () => {
      // The refusal above must not be an id that happened not to match. Under the
      // id shape production actually registers, the current host still writes no
      // lease and still creates no shell.
      expectDriveActuallyRan(currentHostAppIdSpace)
      expect(currentHostAppIdSpace.leaseWrites).toEqual([])
      expect(currentHostAppIdSpace.recoverPaneOutcome).toBe('refused')
      expect(currentHostAppIdSpace.replacementShellsCreated).toBe(0)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the published release expires the lease and grants the duplicate shell',
    () => {
      // The control. Same relay answer, same pane, same request — only the host
      // build differs, and the legacy publication authorizes the mutation the
      // current host refuses. Without this the case above could pass because the
      // harness never reaches a grant at all.
      expectDriveActuallyRan(baselineHost)
      expect(baselineHost.leaseWrites).toEqual([
        { ptyId: SKEW_HOST_PANE.relaySessionId, state: 'expired' }
      ])
      expect(baselineHost.leaseStateAfterFailure).toBe('expired')
      expect(baselineHost.recoverPaneOutcome).toBe('granted')
      expect(baselineHost.replacementShellsCreated).toBe(1)
      // Recorded, not asserted as desirable: the legacy grant is only reachable
      // when the pane's runtime PTY id is the RELAY id. `ipc/pty.ts` registers the
      // APP id while writing the lease under the relay id, and the gate compares
      // them directly — so under the shape production registers, the legacy host
      // refuses too. That id-space mismatch needs its own decision; it is not what
      // this branch changed.
      expect(baselineHostAppIdSpace.leaseWrites).toEqual([
        { ptyId: SKEW_HOST_PANE.relaySessionId, state: 'expired' }
      ])
      expect(baselineHostAppIdSpace.recoverPaneOutcome).toBe('refused')
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'the two hosts differ only in what they authorized, from the same relay answer',
    () => {
      // Names the skew explicitly so a future change that converges the two builds
      // cannot quietly turn this file into a pair of tautologies.
      expect({
        lease: currentHost.leaseStateAfterFailure,
        recovery: currentHost.recoverPaneOutcome,
        shells: currentHost.replacementShellsCreated
      }).not.toEqual({
        lease: baselineHost.leaseStateAfterFailure,
        recovery: baselineHost.recoverPaneOutcome,
        shells: baselineHost.replacementShellsCreated
      })
    },
    SUITE_TIMEOUT_MS
  )
})
