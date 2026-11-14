export type P4Record = Record<string, string>

/** Parses `p4 -ztag` text output: `... key value` lines, records split by blank lines. */
export function parseTaggedOutput(stdout: string): P4Record[] {
  const records: P4Record[] = []
  let current: P4Record = {}
  let lastKey: string | null = null
  let firstKey: string | null = null
  let pendingBlankLines = 0
  const flush = (): void => {
    if (Object.keys(current).length > 0) {
      records.push(current)
    }
    current = {}
    lastKey = null
    firstKey = null
    pendingBlankLines = 0
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') {
      pendingBlankLines += 1
      continue
    }
    if (line.startsWith('... ')) {
      const body = line.slice(4)
      const space = body.indexOf(' ')
      const key = space === -1 ? body : body.slice(0, space)
      // Why: a repeated field starts the next record. A blank line alone does not, because multi-line
      // values (descriptions) are followed by one before the record's remaining fields.
      if (key in current && !/\d$/.test(key)) {
        flush()
      }
      firstKey ??= key
      current[key] = space === -1 ? '' : body.slice(space + 1)
      lastKey = key
      pendingBlankLines = 0
    } else if (lastKey !== null) {
      current[lastKey] += `${'\n'.repeat(pendingBlankLines + 1)}${line}`
      pendingBlankLines = 0
    }
  }
  flush()
  return records
}
