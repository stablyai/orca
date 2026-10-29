import type { SessionSourcePresence } from '../lib/session-source-fields'

/** A native traversal emits its final array and ordered occurrence receipt together. */
export class SessionSourceSequence<Row, Result> {
  constructor(
    private readonly source: readonly Row[],
    private readonly keyOf: (row: Row) => string,
    private readonly emit: (
      rows: Row[],
      groups: Map<string, Row[]>,
      keys: Set<string>,
      reordered: boolean,
      presence: Map<string, SessionSourcePresence>,
      preserveSource?: boolean
    ) => Result
  ) {}

  private collect() {
    const prior = new Map<string, Row[]>(),
      next = new Map<string, Row[]>()
    const push = (groups: Map<string, Row[]>, row: Row): void => {
      const key = this.keyOf(row)
      const rows = groups.get(key)
      if (rows) {
        rows.push(row)
      } else {
        groups.set(key, [row])
      }
    }
    return {
      before: (row: Row) => push(prior, row),
      after: (row: Row) => push(next, row),
      finish: (rows: Row[], preserveSource = false): Result => {
        const keys = new Set<string>()
        for (const [key, entries] of prior) {
          const candidate = next.get(key)
          if (
            !candidate ||
            entries.length !== candidate.length ||
            entries.some((row, i) => row !== candidate[i])
          ) {
            keys.add(key)
          }
        }
        for (const key of next.keys()) {
          if (!prior.has(key)) {
            keys.add(key)
          }
        }
        const applied = [...prior.keys()].filter((key) => next.has(key))
        for (const key of next.keys()) {
          if (!prior.has(key)) {
            applied.push(key)
          }
        }
        const order = [...next.keys()]
        return this.emit(
          rows,
          next,
          keys,
          applied.some((key, i) => key !== order[i]),
          new Map([...keys].map((key) => [key, { before: prior.has(key), after: next.has(key) }])),
          preserveSource
        )
      }
    }
  }

  map(callback: (row: Row, index: number, rows: readonly Row[]) => Row): Result {
    const receipt = this.collect()
    const rows = this.source.map((row, index, source) => {
      receipt.before(row)
      const next = callback(row, index, source)
      receipt.after(next)
      return next
    })
    return receipt.finish(rows)
  }

  filter(callback: (row: Row, index: number, rows: readonly Row[]) => unknown): Result {
    const receipt = this.collect()
    const rows = this.source.filter((row, index, source) => {
      receipt.before(row)
      if (!callback(row, index, source)) {
        return false
      }
      receipt.after(row)
      return true
    })
    return receipt.finish(rows)
  }

  filterAppend(
    keep: (row: Row) => boolean,
    added: readonly Row[],
    equal: (before: readonly Row[], after: readonly Row[]) => boolean
  ): Result {
    const receipt = this.collect()
    const rows = this.source.filter((row) => {
      receipt.before(row)
      if (!keep(row)) {
        return false
      }
      receipt.after(row)
      return true
    })
    for (const row of added) {
      receipt.after(row)
      rows.push(row)
    }
    return receipt.finish(rows, equal(this.source, rows))
  }

  flatMap(
    callback: (row: Row, index: number, rows: readonly Row[]) => Row | readonly Row[]
  ): Result {
    const receipt = this.collect()
    const rows = this.source.flatMap((row, index, source) => {
      receipt.before(row)
      const result = callback(row, index, source)
      const emitted = Array.isArray(result) ? result : [result]
      for (const next of emitted) {
        receipt.after(next)
      }
      return emitted
    })
    return receipt.finish(rows)
  }

  prepend(...added: Row[]): Result {
    const receipt = this.collect()
    for (const row of added) {
      receipt.after(row)
    }
    for (const row of this.source) {
      receipt.before(row)
      receipt.after(row)
    }
    return receipt.finish([...added, ...this.source])
  }

  append(...added: Row[]): Result {
    const receipt = this.collect()
    for (const row of this.source) {
      receipt.before(row)
      receipt.after(row)
    }
    for (const row of added) {
      receipt.after(row)
    }
    return receipt.finish([...this.source, ...added])
  }
}
