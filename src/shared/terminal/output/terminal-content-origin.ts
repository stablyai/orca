/** Ephemeral write attribution; owners are comparable only within one uninterrupted stream. */
export type TerminalContentOrigin = { owner: object; epoch: number }
export type TerminalOriginRun = { start: number; end: number; origin: TerminalContentOrigin }
export type TerminalOriginRuns = readonly TerminalOriginRun[]
export type TerminalSupportQuery = (start: number, end: number) => boolean

export function sliceTerminalOrigins(
  runs: TerminalOriginRuns = [],
  start = 0,
  end = Infinity
): TerminalOriginRuns {
  const sliced: TerminalOriginRun[] = []
  for (const run of runs) {
    const left = Math.max(start, run.start)
    const right = Math.min(end, run.end)
    if (right > left) {
      sliced.push({ start: left - start, end: right - start, origin: run.origin })
    }
  }
  return sliced
}

export function terminalOriginAt(
  runs: TerminalOriginRuns,
  column: number
): TerminalContentOrigin | undefined {
  let left = 0
  let right = runs.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (runs[middle]!.end <= column) {
      left = middle + 1
    } else {
      right = middle
    }
  }
  const run = runs[left]
  return run && run.start <= column ? run.origin : undefined
}

export function writeTerminalOrigins(
  runs: TerminalOriginRuns,
  start: number,
  end: number,
  replacement: TerminalOriginRuns = []
): TerminalOriginRuns {
  const next: TerminalOriginRun[] = []
  const append = (run: TerminalOriginRun): void => {
    if (run.end <= run.start) {
      return
    }
    const previous = next.at(-1)
    if (
      previous?.end === run.start &&
      previous.origin.owner === run.origin.owner &&
      previous.origin.epoch === run.origin.epoch
    ) {
      previous.end = run.end
    } else {
      next.push({ ...run })
    }
  }
  for (const run of runs) {
    if (run.start >= start) {
      break
    }
    append({ ...run, end: Math.min(start, run.end) })
  }
  for (const run of replacement) {
    append({ ...run, start: start + run.start, end: start + run.end })
  }
  for (const run of runs) {
    if (run.end > end) {
      append({ ...run, start: Math.max(end, run.start) })
    }
  }
  return next
}

export function terminalOriginSpan(
  length: number,
  origin?: TerminalContentOrigin
): TerminalOriginRuns {
  return origin && length > 0 ? [{ start: 0, end: length, origin }] : []
}

export function terminalSupportQuery(
  runs: TerminalOriginRuns,
  scope?: TerminalContentOrigin
): TerminalSupportQuery | undefined {
  if (!scope?.epoch) {
    return undefined
  }
  const old: { start: number; end: number }[] = []
  for (const run of runs) {
    if (run.origin.owner === scope.owner && run.origin.epoch < scope.epoch) {
      const last = old.at(-1)
      if (last && last.end > run.start) {
        last.end = Math.max(last.end, run.end)
      } else {
        old.push({ start: run.start, end: run.end })
      }
    }
  }
  if (!old.length) {
    return undefined
  }
  return (start, end) => {
    let left = 0
    let right = old.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (old[middle]!.end <= start) {
        left = middle + 1
      } else {
        right = middle
      }
    }
    return left === old.length || old[left]!.start >= end
  }
}

export function offsetTerminalSupport(query: TerminalSupportQuery | undefined, offset: number) {
  return query ? (start: number, end: number) => query(start + offset, end + offset) : undefined
}

/** Case conversion can expand a code point; queries continue to address the original text. */
export function lowercaseTerminalSupport(text: string, query?: TerminalSupportQuery) {
  const lower = text.toLowerCase()
  if (!query || lower.length === text.length) {
    return { text: lower, query }
  }
  const positions: number[] = []
  let offset = 0
  for (const character of text) {
    for (let i = 0; i < character.toLowerCase().length; i++) {
      positions.push(offset)
    }
    offset += character.length
  }
  positions.push(text.length)
  return {
    text: lower,
    query: (start: number, end: number) =>
      query(
        positions[start] ?? text.length,
        end > start
          ? (positions[end - 1] ?? text.length) +
              (text.codePointAt(positions[end - 1]!)! > 0xffff ? 2 : 1)
          : (positions[end] ?? text.length)
      )
  }
}

// Array identity carries the optional local certificate without changing any wire/saved rows.
const lineOrigins = new WeakMap<readonly string[], readonly TerminalOriginRuns[]>()
export function setTerminalLineOrigins(
  lines: readonly string[],
  origins: readonly TerminalOriginRuns[]
): void {
  lineOrigins.set(lines, origins)
}
export function getTerminalLineOrigins(
  lines: readonly string[]
): readonly TerminalOriginRuns[] | undefined {
  return lineOrigins.get(lines)
}

export function joinedTerminalOrigins(
  lines: readonly string[],
  trim = false
): { text: string; origins: TerminalOriginRuns } {
  const source = getTerminalLineOrigins(lines)
  const origins: TerminalOriginRun[] = []
  const kept: string[] = []
  let length = 0
  lines.forEach((line, index) => {
    const text = trim ? line.trim() : line
    if (trim && !text) {
      return
    }
    if (kept.length) {
      length++
    }
    const start = trim ? line.length - line.trimStart().length : 0
    for (const run of sliceTerminalOrigins(source?.[index], start, start + text.length)) {
      origins.push({ ...run, start: length + run.start, end: length + run.end })
    }
    kept.push(text)
    length += text.length
  })
  return { text: kept.join('\n'), origins }
}

export type TerminalScreenSupportQuery = (row: number, start: number, end: number) => boolean
export function terminalScreenSupport(
  lines: readonly string[],
  scope?: TerminalContentOrigin
): TerminalScreenSupportQuery | undefined {
  const runs = getTerminalLineOrigins(lines)
  if (!runs || !scope?.epoch) {
    return undefined
  }
  const queries = runs.map((row) => terminalSupportQuery(row, scope))
  return (row, start, end) => queries[row]?.(start, end) ?? true
}
