// The background clone of an Orca Cloud create, read from the provider's build-log lines
// (`[orca-cloud] cloning` or `updating`, `[orca-cloud] clone-progress <percent> <stage>`, then the next phase).
const PHASE_LINE = /^\[orca-cloud\] ([a-z-]+)$/
const CLONE_PROGRESS_LINE = /^\[orca-cloud\] clone-progress (\d{1,3}) (download|checkout)$/

export type OrcaCloudCloneProgress = {
  /** 'update': the repo came prebuilt (an environment build) and only changes are fetched. */
  mode: 'clone' | 'update'
  startedAt: number | null
  /** The next phase began: the clone finished. */
  ended: boolean
  /** When it ended, if the line has a stamp. */
  endedAt: number | null
  percent: number | null
  stage: 'download' | 'checkout' | null
}

/**
 * The background clone, from the provider's `[orca-cloud] cloning` / `clone-progress <percent> <stage>`
 * lines and their arrival stamps. Null when this create had no clone step (the log never says cloning).
 */
export function orcaCloudCloneProgress(
  log: string,
  stamps: readonly number[]
): OrcaCloudCloneProgress | null {
  const lines = log.split('\n')
  let progress: OrcaCloudCloneProgress | null = null
  lines.forEach((raw, index) => {
    const line = raw.trim()
    const stamp = stamps[index] ?? null
    if (line === '[orca-cloud] cloning' || line === '[orca-cloud] updating') {
      progress = {
        mode: line.endsWith('updating') ? 'update' : 'clone',
        startedAt: stamp,
        ended: false,
        endedAt: null,
        percent: null,
        stage: null
      }
      return
    }
    if (!progress) {
      return
    }
    const match = CLONE_PROGRESS_LINE.exec(line)
    if (match) {
      progress.percent = Math.min(100, Number(match[1]))
      progress.stage = match[2] === 'checkout' ? 'checkout' : 'download'
      return
    }
    const phase = PHASE_LINE.exec(line)?.[1]
    if (phase && !progress.ended) {
      progress.ended = true
      progress.endedAt = stamp
    }
  })
  return progress
}

/** The repository step's mode as announced before the create answered (`[orca-cloud] plan-clone|plan-update`). */
export function orcaCloudPlannedRepoMode(log: string): 'clone' | 'update' | null {
  const match = /^\[orca-cloud\] plan-(clone|update)$/m.exec(log)
  return match ? (match[1] === 'update' ? 'update' : 'clone') : null
}
