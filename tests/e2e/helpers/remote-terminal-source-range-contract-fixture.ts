import type { TerminalOutputSourceRange } from '../../../src/shared/terminal-output-source-range'
import { TerminalSourceRangeLedger } from '../../../src/main/runtime/rpc/terminal-source-range-ledger'

export type RemoteTerminalContractTopology = 'headed-desktop-server' | 'headless-serve'

export function createRemoteTerminalSourceRangeContractFixture(
  topology: RemoteTerminalContractTopology
) {
  const settled: TerminalOutputSourceRange[] = []
  const transferred: TerminalOutputSourceRange[] = []
  let generationCounter = 0
  let active:
    | {
        generation: string
        ledger: TerminalSourceRangeLedger
      }
    | undefined

  return {
    topology,
    evidence: 'deterministic-contract-fixture' as const,
    hostPtyIdentity: 'host-owned-pty',
    connect() {
      const generation = `${topology}:stream:${++generationCounter}`
      active = { generation, ledger: new TerminalSourceRangeLedger(generation) }
      return generation
    },
    accept(encodedBytes: number, ranges: readonly TerminalOutputSourceRange[]) {
      const displayLength =
        ranges.length > 0 ? ranges.at(-1)!.displayEnd - ranges[0]!.displayStart : 0
      return active?.ledger.accept(encodedBytes, displayLength, ranges) ?? null
    },
    acknowledge(generation: string, ackedEndByte: number) {
      if (!active) {
        throw new Error('remote_terminal_fixture_disconnected')
      }
      const result = active.ledger.acknowledge(generation, ackedEndByte)
      if (result.status === 'accepted') {
        settled.push(...result.settled)
      }
      return result
    },
    detach() {
      if (!active) {
        return
      }
      const transfer = active.ledger.beginTransfer()
      transferred.push(...transfer.frames.flatMap((frame) => frame.sourceRanges))
      transfer.commit()
      active = undefined
    },
    snapshot() {
      return {
        settled: settled.slice(),
        transferred: transferred.slice(),
        active: active?.ledger.getDebugSnapshot() ?? null
      }
    }
  }
}
