/**
 * A host that publishes NO `processEvidence` cannot prove a workspace is idle.
 *
 * Retained pre-v27 daemons (protocol 11-26) expose only `getForegroundProcess`,
 * so `DaemonPtyProcessInspection.inspectProcess` composes the pair client-side
 * through `composeLegacyPtyProcessInspection` and publishes no evidence. Those
 * daemons emit `zsh` + `hasChildProcesses: false` BOTH when the pane really sits
 * at an idle shell AND when their foreground read fell back to the shell title
 * (`pty-subprocess.ts` returns node-pty's `.process` when the agent scan cannot
 * corroborate it), with no field to separate the two. `readPtyProcessInspection\
 * Evidence` restates that pair as an OBSERVATION for hosts that predate the
 * field, which is the right reading for callers that act on presence — and the
 * wrong one here, where the verdict decides whether a workspace is deleted.
 *
 * Producer fidelity: the fixtures below call the same
 * `composeLegacyPtyProcessInspection` the daemon adapter calls, so they cannot
 * drift from the real bytes. The adapter's use of it is pinned by
 * `daemon-pty-adapter-protocol-compatibility.test.ts`, "reports an idle shell as
 * having no child processes".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { canQueueWorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { buildWorkspaceCleanupFacets } from '@/components/workspace-cleanup/workspace-cleanup-facets'
import {
  buildPtyProcessInspectionWireResult,
  composeLegacyPtyProcessInspection
} from '../../../../shared/pty-process-inspection-evidence'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { probeTerminalLiveness } from './workspace-cleanup-local-evidence'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  makeCandidate,
  makeState
} from './workspace-cleanup-slice-test-harness'

const TAB_ID = 'tab-1'
const PTY_ID = 'pty-1'
const TABS = [{ id: TAB_ID, title: 'zsh' }]

let currentInspect: () => Promise<unknown> = async () => {
  throw new Error('no inspection installed')
}

function installApi(inspectProcess: () => Promise<unknown>, scan = vi.fn()) {
  currentInspect = inspectProcess
  ;(globalThis as { window: unknown }).window = {
    api: {
      workspaceCleanup: {
        scan,
        getCachedScan: vi.fn().mockResolvedValue(null),
        dismiss: vi.fn().mockResolvedValue(undefined),
        clearDismissals: vi.fn().mockResolvedValue(undefined),
        hasKillableLocalProcesses: vi.fn().mockResolvedValue({ hasKillableProcesses: false })
      },
      pty: {
        // The coerced standalone reads stay installed so a test can only pass by
        // consulting the evidence-carrying handler.
        hasChildProcesses: vi.fn().mockResolvedValue(false),
        getForegroundProcess: vi.fn().mockResolvedValue('zsh'),
        inspectProcess: vi.fn(inspectProcess),
        confirmForegroundProcess: vi.fn().mockResolvedValue(null)
      }
    }
  }
}

const LIVE_STATE = {
  tabsByWorktree: { [WORKTREE_ID]: TABS },
  ptyIdsByTabId: { [TAB_ID]: [PTY_ID] }
} as unknown as Partial<AppState>

function stateWithOnePty(): AppState {
  return makeState(LIVE_STATE)
}

async function enrichOne(): Promise<WorkspaceCleanupCandidate> {
  const [candidate] = await enrichWorkspaceCleanupCandidates([makeCandidate()], stateWithOnePty(), {
    applyDismissals: false
  })
  return candidate!
}

function isSweptBySelectAll(candidate: WorkspaceCleanupCandidate): boolean {
  return buildWorkspaceCleanupFacets(candidate).isSelectable
}

/** The real removal, entered from a row the user confirmed as carrying no blockers. */
async function removeAfterConfirmingACleanRow() {
  const scan = vi.fn().mockResolvedValue({
    scannedAt: NOW,
    candidates: [makeCandidate()],
    errors: []
  } satisfies WorkspaceCleanupScanResult)
  // Re-install so the preflight's own scan resolves; the inspection is unchanged.
  installApi(currentInspect, scan)
  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState(LIVE_STATE as AppState)
  const result = await store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
    approvedCandidates: [makeCandidate({ blockers: [] })]
  })
  return { removeWorktree, result }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('an unpublished-evidence host cannot prove idle', () => {
  it('reports unverifiable for a legacy daemon whose foreground read is a bare shell', async () => {
    installApi(async () => composeLegacyPtyProcessInspection('zsh'))

    await expect(probeTerminalLiveness(stateWithOnePty(), TABS)).resolves.toBe('unverifiable')
  })

  it('reports unverifiable for a legacy daemon that named nothing at all', async () => {
    installApi(async () => composeLegacyPtyProcessInspection(null))

    await expect(probeTerminalLiveness(stateWithOnePty(), TABS)).resolves.toBe('unverifiable')
  })

  it('withholds the legacy row from select-all instead of letting it look clean', async () => {
    installApi(async () => composeLegacyPtyProcessInspection('zsh'))

    const candidate = await enrichOne()

    expect(candidate.blockers).toContain('terminal-liveness-unknown')
    expect(candidate.blockers).not.toContain('running-terminal')
    expect(isSweptBySelectAll(candidate)).toBe(false)
    // Unverifiable is a disclosure, not a dead end: a hand-ticked row still removes.
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
  })

  it('does not delete the workspace when the legacy row was confirmed as clean', async () => {
    // The outcome that matters: the preflight re-probe is the last chance to
    // catch a pane this host cannot vouch for, and it must spend it.
    installApi(async () => composeLegacyPtyProcessInspection('zsh'))

    const { removeWorktree, result } = await removeAfterConfirmingACleanRow()

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.worktreeId).toBe(WORKTREE_ID)
  })
})

describe('what an unpublished-evidence host may still establish', () => {
  it('still reports running when the legacy host named live work', async () => {
    // Believing a positive live read can only ADD a blocker, so it stays believed.
    installApi(async () => composeLegacyPtyProcessInspection('node'))

    await expect(probeTerminalLiveness(stateWithOnePty(), TABS)).resolves.toBe('running')
  })

  it('still blocks on running-terminal for a legacy host hosting an agent', async () => {
    installApi(async () => composeLegacyPtyProcessInspection('claude'))

    const candidate = await enrichOne()

    expect(candidate.blockers).toContain('running-terminal')
    expect(candidate.blockers).not.toContain('terminal-liveness-unknown')
  })
})

describe('a host that DOES publish evidence keeps its verdicts', () => {
  it('still permits cleanup when the host observed an idle shell and said so', async () => {
    installApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'zsh' },
        { verdict: 'exited' }
      )
    )

    const candidate = await enrichOne()

    expect(candidate.blockers).toEqual([])
    expect(isSweptBySelectAll(candidate)).toBe(true)
  })

  it('deletes a workspace the host positively vouched for', async () => {
    // The polarity control for the removal assertion above: without this, a
    // "removal was blocked" result could just mean the preflight blocks everything.
    installApi(async () =>
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'zsh' },
        { verdict: 'exited' }
      )
    )

    const { removeWorktree, result } = await removeAfterConfirmingACleanRow()

    expect(removeWorktree).toHaveBeenCalledTimes(1)
    expect(result.failures).toEqual([])
  })
})
