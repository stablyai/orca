export type P4Record = Record<string, string>

/** Parses `p4 -ztag` text output: `... key value` lines, records split by blank lines. */
export function parseTaggedOutput(stdout: string): P4Record[] {
  const records: P4Record[] = []
  let current: P4Record = {}
  let lastKey: string | null = null
  let pendingBlankLines = 0
  const flush = (): void => {
    if (Object.keys(current).length > 0) {
      records.push(current)
    }
    current = {}
    lastKey = null
    pendingBlankLines = 0
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') {
      pendingBlankLines += 1
      continue
    }
    if (line.startsWith('... ')) {
      // Why: a blank line only ends a record when a new tagged field follows it;
      // otherwise it is part of a multi-line value such as a description.
      if (pendingBlankLines > 0) {
        flush()
      }
      const body = line.slice(4)
      const space = body.indexOf(' ')
      const key = space === -1 ? body : body.slice(0, space)
      // Records without blank separators repeat their first key to start the next one.
      if (key in current && !/\d$/.test(key)) {
        flush()
      }
      current[key] = space === -1 ? '' : body.slice(space + 1)
      lastKey = key
    } else if (lastKey !== null) {
      current[lastKey] += `${'\n'.repeat(pendingBlankLines + 1)}${line}`
      pendingBlankLines = 0
    }
  }
  flush()
  return records
}
