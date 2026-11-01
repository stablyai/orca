import { probeAgentProcessPresence } from './agent-process-presence-probe'
import {
  createHookRootEvidenceReader,
  type HookRootEvidenceReader
} from './hook-process-root-evidence'
import { getStrictProcessTableSnapshotWithAge } from './process-table-snapshot-reader'

/** Root evidence from this host's own process table, shared with the other evidence readers. */
export function createLocalHookRootEvidenceReader(): HookRootEvidenceReader {
  return createHookRootEvidenceReader({
    probe: (process) => probeAgentProcessPresence(process),
    readTable: async () => (await getStrictProcessTableSnapshotWithAge()).rows
  })
}
