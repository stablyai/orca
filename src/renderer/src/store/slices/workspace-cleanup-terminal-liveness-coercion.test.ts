import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { canQueueWorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { buildWorkspaceCleanupFacets } from '@/components/workspace-cleanup/workspace-cleanup-facets'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { probeTerminalLiveness } from './workspace-cleanup-local-evidence'
import { WORKTREE_ID, makeCandidate, makeState } from './workspace-cleanup-slice-test-harness'
import {
  buildPtyProcessInspectionWireResult,
  type PtyProcessInspectionEvidence
} from '../../../../shared/pty-process-inspection-evidence'

type PtyInspectionWithEvidence = PtyInspection & {
  processEvidence: PtyProcessInspectionEvidence
}

const TAB_ID = 'tab-1'
const PTY_ID = 'pty-1'

type PtyInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
}

/**
 * Models the three answers main really gives for ONE pty read. The standalone
 * `hasChildProcesses`/`getForegroundProcess` handlers coerce a degraded read to
 * `false`/`null` before it crosses IPC; only `inspectProcess` carries evidence.
 */
function installPtyApi(inspection: {
  hasChildProcesses: boolean
  foregroundProcess: string | null
  inspectProcess: () => Promise<PtyInspection>
}) {
  const calls = { hasChildProcesses: 0, getForegroundProcess: 0, inspectProcess: 0 }
  ;(globalThis as { window: unknown }).window = {
    api: {
      pty: {
        hasChildProcesses: vi.fn(async () => {
          calls.hasChildProcesses += 1
          return inspection.hasChildProcesses
        }),
        getForegroundProcess: vi.fn(async () => {
          calls.getForegroundProcess += 1
          return inspection.foregroundProcess
        }),
        inspectProcess: vi.fn(async () => {
          calls.inspectProcess += 1
          return inspection.inspectProcess()
        }),
        confirmForegroundProcess: vi.fn(async () => null)
      }
    }
  }
  return calls
}

/** A degraded read: main answered, but the answer carries no process evidence. */
function installDegradedPtyApi(inspection: () => Promise<PtyInspection>) {
  // Why: the standalone reads are SWALLOWED below IPC (a disconnected SSH
  // provider short-circuits to false/null; the daemon adapter catches its own
  // dead-socket request and returns null). Nothing throws at the caller.
  return installPtyApi({
    hasChildProcesses: false,
    foregroundProcess: null,
    inspectProcess: inspection
  })
}

function stateWithOnePty(overrides: Partial<AppState> = {}): AppState {
  return makeState({
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, title: 'zsh' }] } as never,
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    ...overrides
  })
}

/**
 * The gate the dialog actually reads. `tier`/`selectedByDefault` are @deprecated and no
 * renderer consults them, so asserting on those would pass against dead code and read as
 * protection that does not exist.
 */
function isSweptBySelectAll(candidate: WorkspaceCleanupCandidate): boolean {
  return buildWorkspaceCleanupFacets(candidate).isSelectable
}

async function enrichOne(state: AppState) {
  const [candidate] = await enrichWorkspaceCleanupCandidates([makeCandidate()], state, {
    applyDismissals: false
  })
  return candidate!
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('a degraded terminal read is unverifiable, never idle', () => {
  it('reports unverifiable when the host answers without process evidence', async () => {
    installDegradedPtyApi(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    }))

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })

  it('blocks cleanup on an unavailable read instead of letting the row look clean', async () => {
    installDegradedPtyApi(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    }))

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toContain('terminal-liveness-unknown')
    expect(candidate.blockers).not.toContain('running-terminal')
    // Withheld from select-all...
    expect(isSweptBySelectAll(candidate)).toBe(false)
    // ...but still deletable on purpose, so an unverifiable workspace is never a dead end.
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
  })

  it('reports unverifiable when contact with the host is lost mid-read', async () => {
    // Why: a dead daemon socket rejects `inspectProcess` while the standalone
    // reads still resolve false/null — a swallowing adapter, not a thrower.
    installDegradedPtyApi(async () => {
      throw new Error('terminal_gone')
    })

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toContain('terminal-liveness-unknown')
    expect(isSweptBySelectAll(candidate)).toBe(false)
  })

  it('reads the evidence-carrying handler, not the coerced ones', async () => {
    const calls = installDegradedPtyApi(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    }))

    await probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])

    expect(calls.inspectProcess).toBe(1)
    expect(calls.hasChildProcesses).toBe(0)
    expect(calls.getForegroundProcess).toBe(0)
  })
})

describe('verified reads keep their existing verdicts', () => {
  it('still permits cleanup for a genuinely idle shell', async () => {
    // The host must SAY it observed the shell. The same two legacy values with no
    // evidence are what a pre-v27 daemon publishes for a degraded read too, and
    // that case is unverifiable — see
    // workspace-cleanup-legacy-host-liveness-evidence.test.ts.
    installPtyApi({
      hasChildProcesses: false,
      foregroundProcess: 'zsh',
      inspectProcess: async () =>
        buildPtyProcessInspectionWireResult(
          { verdict: 'observed', processName: 'zsh' },
          { verdict: 'exited' }
        )
    })

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toEqual([])
    expect(isSweptBySelectAll(candidate)).toBe(true)
  })

  it('still blocks cleanup for a live agent', async () => {
    // Evidence-less on purpose: a host that cannot publish evidence is still
    // believed when it names live work, because that can only add a blocker.
    installPtyApi({
      hasChildProcesses: true,
      foregroundProcess: 'claude',
      inspectProcess: async () => ({ foregroundProcess: 'claude', hasChildProcesses: true })
    })

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toContain('running-terminal')
  })

  it('still permits cleanup for a worktree with no terminals at all', async () => {
    installPtyApi({
      hasChildProcesses: false,
      foregroundProcess: null,
      inspectProcess: async () => {
        throw new Error('should not be asked about a worktree with no ptys')
      }
    })

    const candidate = await enrichOne(makeState())

    expect(candidate.blockers).toEqual([])
    expect(isSweptBySelectAll(candidate)).toBe(true)
  })
})

describe('a degraded read whose host DID answer is still unverifiable, never idle', () => {
  /**
   * The exact bytes `LocalPtyProvider.inspectProcess` publishes when the
   * foreground scan is degraded: the legacy fields keep the pre-evidence
   * collapse on purpose (see buildPtyProcessInspectionWireResult), so a failed
   * probe is byte-identical to an idle shell unless the reader consults
   * `processEvidence`. Built through the real classifier rather than a literal
   * so a change to the producer cannot leave this fixture describing a shape
   * the host never sends.
   */
  function degradedLocalInspection(shell: string): PtyInspectionWithEvidence {
    return {
      ...buildPtyProcessInspectionWireResult(
        { verdict: 'unverifiable', reason: 'process table scan degraded' },
        {
          verdict: 'unverifiable',
          reason: 'pty title matches the shell while the foreground scan is degraded'
        }
      ),
      // The one deliberate override: the provider publishes its stable-cache
      // legacy value, which for a pane that never ran an agent is the shell
      // name. See local-pty-provider-inspect-process-evidence.test.ts,
      // "keeps the stable-cache legacy value but marks a degraded scan
      // unverifiable".
      foregroundProcess: shell
    }
  }

  it('reports unverifiable for a degraded local probe that looks like an idle shell', async () => {
    installDegradedPtyApi(async () => degradedLocalInspection('zsh'))

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })

  it('withholds a degraded local probe from select-all', async () => {
    installDegradedPtyApi(async () => degradedLocalInspection('zsh'))

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toContain('terminal-liveness-unknown')
    expect(isSweptBySelectAll(candidate)).toBe(false)
    // Still individually removable: unverifiable is not a dead end.
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
  })

  it('reports unverifiable for a relay host whose probes timed out', async () => {
    // The real relay producer, so the legacy collapse is the host's own.
    installDegradedPtyApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'unverifiable', reason: 'ps did not answer before its deadline' },
        { verdict: 'unverifiable', reason: 'pgrep did not answer before its deadline' }
      )
    )

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })

  it('reports unverifiable when only the child probe failed', async () => {
    installDegradedPtyApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'zsh' },
        { verdict: 'unverifiable', reason: 'pgrep is not installed on this host' }
      )
    )

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })

  it('still permits cleanup when the host observed an idle shell and said so', async () => {
    installDegradedPtyApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'zsh' },
        { verdict: 'exited' }
      )
    )

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toEqual([])
    expect(isSweptBySelectAll(candidate)).toBe(true)
  })

  it('still blocks when the host observed a live agent', async () => {
    installDegradedPtyApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'claude' },
        { verdict: 'live' }
      )
    )

    const candidate = await enrichOne(stateWithOnePty())

    expect(candidate.blockers).toContain('running-terminal')
  })
})
