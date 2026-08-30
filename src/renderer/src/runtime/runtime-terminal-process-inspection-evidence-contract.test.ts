import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from './runtime-terminal-process-inspection'
import {
  buildPtyProcessInspectionWireResult,
  readPtyProcessInspectionEvidence,
  type PtyProcessInspectionEvidence
} from '../../../shared/pty-process-inspection-evidence'
import { probeTerminalLiveness } from '@/store/slices/workspace-cleanup-local-evidence'
import { makeState, WORKTREE_ID } from '@/store/slices/workspace-cleanup-slice-test-harness'

/**
 * Merge-order guard for #17024 vs the #16955 stack.
 *
 * #17024 MOVES this inspection type out of runtime-terminal-inspection.ts and
 * into this leaf module; #16955 ADDS `processEvidence` to it in the old file.
 * The two conflict, and the tempting resolution ("keep the moved type, the
 * field was in the file that went away") drops the field. Nothing on main reads
 * it, so that resolution is silent in the order where #17024 lands first.
 *
 * Compile-time half: this read is a type error the moment the declaration
 * leaves the leaf module, so a bad resolution fails `pnpm tc` at a named site.
 */
function readDeclaredProcessEvidence(
  inspection: RuntimeTerminalProcessInspection
): PtyProcessInspectionEvidence | undefined {
  return inspection.processEvidence
}

const PTY_ID = 'pty-1'
const TAB_ID = 'tab-1'

/** A local pane whose host answered, but whose probes could not run. */
const DEGRADED_LOCAL_READ = {
  ...buildPtyProcessInspectionWireResult(
    { verdict: 'unverifiable', reason: 'process table scan degraded' },
    {
      verdict: 'unverifiable',
      reason: 'pty title matches the shell while the foreground scan is degraded'
    }
  ),
  // The provider's stable-cache legacy value; for a pane that never ran an
  // agent it is the shell name, which is what makes the legacy half of this
  // answer indistinguishable from a genuinely idle shell.
  foregroundProcess: 'zsh'
}

function installPtyApi(inspectProcess: () => Promise<unknown>) {
  vi.stubGlobal('window', {
    api: {
      pty: {
        inspectProcess: vi.fn(inspectProcess),
        hasChildProcesses: vi.fn(async () => false),
        getForegroundProcess: vi.fn(async () => null),
        confirmForegroundProcess: vi.fn(async () => null)
      }
    }
  })
}

function stateWithOnePty() {
  return makeState({
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, title: 'zsh' }] } as never,
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the local inspection route carries host process evidence', () => {
  it('hands the evidence to the reader instead of projecting it away', async () => {
    installPtyApi(async () => DEGRADED_LOCAL_READ)

    const inspection = await inspectRuntimeTerminalProcess(
      { activeRuntimeEnvironmentId: null },
      PTY_ID
    )

    expect(readDeclaredProcessEvidence(inspection)).toEqual(DEGRADED_LOCAL_READ.processEvidence)
    // The real reader, not a shape assertion: this is the value the cleanup
    // gate acts on.
    expect(readPtyProcessInspectionEvidence(inspection)).toEqual(
      DEGRADED_LOCAL_READ.processEvidence
    )
  })

  it('names the cost of losing the field: no host can vouch for a workspace again', async () => {
    // The cleanup gate now fails CLOSED on a host that published nothing at all
    // (a retained pre-v27 daemon publishes an idle-looking pair for a degraded
    // read too), so dropping the field no longer opens a silent delete. What it
    // destroys instead is the only way to say "safe": strip the field and even a
    // host that positively observed an idle shell reads as unverifiable, so
    // cleanup can never sweep anything again.
    const OBSERVED_IDLE = buildPtyProcessInspectionWireResult(
      { verdict: 'observed', processName: 'zsh' },
      { verdict: 'exited' }
    )
    installPtyApi(async () => OBSERVED_IDLE)

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('idle')

    // Strip only `processEvidence`, exactly as the bad merge resolution would.
    const { processEvidence: _dropped, ...withoutEvidence } = OBSERVED_IDLE
    installPtyApi(async () => withoutEvidence)

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })

  it('keeps a degraded read unverifiable whether or not the field survives', async () => {
    // Defense in depth: the stated-degrade path and the published-nothing path
    // reach the same verdict, so a lost field cannot turn a failed probe into a
    // deletable idle shell.
    installPtyApi(async () => DEGRADED_LOCAL_READ)

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')

    const { processEvidence: _dropped, ...withoutEvidence } = DEGRADED_LOCAL_READ
    installPtyApi(async () => withoutEvidence)

    await expect(
      probeTerminalLiveness(stateWithOnePty(), [{ id: TAB_ID, title: 'zsh' }])
    ).resolves.toBe('unverifiable')
  })
})
