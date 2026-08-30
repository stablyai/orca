import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from './runtime-terminal-inspection'
import {
  readPtyProcessInspectionEvidence,
  type PtyProcessInspectionEvidence
} from '../../../shared/pty-process-inspection-evidence'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

/**
 * Compile-time half: this read is a type error if `processEvidence` ever leaves
 * the inspection type, so a merge resolution that drops it fails the typecheck
 * HERE, at a named site.
 *
 * Why it needs its own guard: the field is optional and every reader guards it,
 * so dropping the declaration changes meaning without changing anything at the
 * call sites — and the producer lives in a different module from the consumer.
 */
function readDeclaredProcessEvidence(
  inspection: RuntimeTerminalProcessInspection
): PtyProcessInspectionEvidence | undefined {
  return inspection.processEvidence
}

const HOST_EVIDENCE = {
  foreground: { verdict: 'unverifiable', reason: 'ps did not answer before its deadline' },
  children: { verdict: 'unverifiable', reason: 'pgrep did not answer before its deadline' }
} as const

describe('runtime terminal inspection carries host process evidence', () => {
  const runtimeCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        process: {
          foregroundProcess: 'zsh',
          hasChildProcesses: false,
          processEvidence: HOST_EVIDENCE
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: (request: RuntimeEnvironmentCallRequest) =>
            createCompatibleRuntimeStatusResponseIfNeeded(request) ?? runtimeCall(request)
        },
        pty: {
          inspectProcess: vi.fn(),
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn()
        }
      }
    })
  })

  it('hands the host evidence to the reader instead of projecting it away', async () => {
    const inspection = await inspectRuntimeTerminalProcess(
      { activeRuntimeEnvironmentId: 'env-1' },
      'remote:env-1@@terminal-1'
    )

    expect(readDeclaredProcessEvidence(inspection)).toEqual(HOST_EVIDENCE)
    // The real reader, not a shape assertion: this is the value the completion
    // gate acts on.
    expect(readPtyProcessInspectionEvidence(inspection)).toEqual(HOST_EVIDENCE)
  })

  it('reads the same degraded answer as a positive exit once the evidence is gone', async () => {
    const inspection = await inspectRuntimeTerminalProcess(
      { activeRuntimeEnvironmentId: 'env-1' },
      'remote:env-1@@terminal-1'
    )
    const { processEvidence: _dropped, ...withoutEvidence } = inspection

    // The cost of dropping the field, stated: the legacy fallback promotes a
    // host that could not answer to an OBSERVED shell with EXITED children —
    // positive exit evidence, from a read that observed nothing.
    expect(readPtyProcessInspectionEvidence(withoutEvidence)).toEqual({
      foreground: { verdict: 'observed', processName: 'zsh' },
      children: { verdict: 'exited' }
    })
  })
})
