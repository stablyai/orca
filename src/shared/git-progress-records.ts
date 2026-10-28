/** One `Title: NN% (x/y)` record from git's stderr progress meter. */
export type GitProgressRecord = {
  percent: number
  completed: number
  total: number
  /** The final `, done.` record. */
  done: boolean
}

const COUNTERS = /^\s*(\d+)% \((\d+)\/(\d+)\)(, done\.)?/
// Git redraws with CR; separator-free text is not progress, so retain only a bounded tail.
const MAX_PENDING_CHARS = 256

/** Read one title’s progress records across stderr chunks, ignoring other diagnostics. */
export function createGitProgressRecordReader(
  title: string,
  onRecord: (record: GitProgressRecord) => void
): (chunk: string) => void {
  const prefix = `${title}:`
  let pending = ''
  // Meters wider than COLUMNS (80 by default in pipes) print the title once, then bare counters.
  let titleOnOwnLine = false

  const readLine = (line: string): void => {
    if (line === '') {
      return
    }
    if (line.startsWith(prefix)) {
      const counters = line.slice(prefix.length)
      titleOnOwnLine = counters.trim() === ''
      readCounters(counters)
      return
    }
    if (titleOnOwnLine && !readCounters(line)) {
      titleOnOwnLine = false
    }
  }

  const readCounters = (text: string): boolean => {
    const match = COUNTERS.exec(text)
    if (!match) {
      return false
    }
    const total = Number(match[3])
    if (total <= 0) {
      return false
    }
    onRecord({
      percent: Math.min(100, Number(match[1])),
      completed: Number(match[2]),
      total,
      done: match[4] !== undefined
    })
    return true
  }

  return (chunk) => {
    const lines = (pending + chunk).split(/\r\n|\r|\n/)
    pending = (lines.pop() ?? '').slice(-MAX_PENDING_CHARS)
    for (const line of lines) {
      readLine(line)
    }
  }
}
