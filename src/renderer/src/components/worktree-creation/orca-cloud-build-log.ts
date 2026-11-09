import type { Translate } from '@/i18n/use-translate'

// The hosted provider streams `[orca-cloud] <phase>` progress lines; show them as words, not codes.
const PHASE_LINE = /^\[orca-cloud\] ([a-z-]+)$/

function phaseLabel(phase: string, t: Translate): string | null {
  switch (phase) {
    case 'checking-entitlement':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.checkingPlan',
        'Checking your plan…'
      )
    case 'provisioning':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.provisioning',
        'Starting the sandbox…'
      )
    case 'booting':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.booting',
        'Booting the sandbox…'
      )
    case 'connecting':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.connecting',
        'Connecting to the sandbox…'
      )
    default:
      return null
  }
}

/** A progress line in plain words; any other line is returned unchanged. */
export function humanizeOrcaCloudLogLine(line: string, t: Translate): string {
  const phase = PHASE_LINE.exec(line.trim())?.[1]
  return (phase && phaseLabel(phase, t)) ?? line
}

// "Starting the sandbox…" would only repeat the step's own label.
const DETAIL_PHASES = new Set(['checking-entitlement', 'booting', 'connecting'])

/** The latest progress phase in the log, in plain words, for the running step's detail line. */
export function latestOrcaCloudPhaseLabel(log: string, t: Translate): string | null {
  const lines = log.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const phase = PHASE_LINE.exec(lines[index].trim())?.[1]
    if (phase && phaseLabel(phase, t)) {
      return DETAIL_PHASES.has(phase) ? phaseLabel(phase, t) : null
    }
  }
  return null
}
