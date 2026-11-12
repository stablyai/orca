// Cloud-start telemetry: the share of first cloud starts where the agent was already covered.
// Enum-only, once per install; the composer's Agent row notes what it showed, the start reports it.
import { track } from '@/diagnostics/telemetry/telemetry'
import type { OrcaCloudAgentSetupRowModel } from './orca-cloud-agent-setup-row'

const REPORTED_KEY = 'orca.cloud.firstStartAgentCoverageReported'

type Coverage = 'account' | 'key' | 'none' | 'unknown'
let latest: { agent: string; coverage: Coverage } | null = null

function coverageOf(row: OrcaCloudAgentSetupRowModel): Coverage {
  switch (row.kind) {
    case 'covered':
      return row.via === 'account' ? 'account' : 'key'
    case 'notSetUp':
    case 'expired':
    case 'killSwitch':
    case 'signedOut':
      return 'none'
    case 'hidden':
    case 'loading':
    case 'error':
      return 'unknown'
  }
}

/** The Agent row calls this with what it currently shows. */
export function noteComposerAgentCoverage(row: OrcaCloudAgentSetupRowModel): void {
  latest = row.kind === 'hidden' ? null : { agent: row.agent, coverage: coverageOf(row) }
}

/** Call when a cloud workspace start is submitted; reports only the first one on this install. */
export function reportCloudStartAgentCoverage(agent: string | null): void {
  try {
    if (window.localStorage.getItem(REPORTED_KEY)) {
      return
    }
    window.localStorage.setItem(REPORTED_KEY, '1')
  } catch {
    return
  }
  const known = agent === 'claude' || agent === 'codex' ? agent : 'other'
  track('cloud_first_start_agent_coverage', {
    agent: known,
    coverage: latest && latest.agent === agent ? latest.coverage : 'unknown'
  })
}

/** Test seam. */
export function resetCloudStartAgentCoverage(): void {
  latest = null
}
