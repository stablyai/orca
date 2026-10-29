import type { SessionMapField } from './session-change-set'

type FieldOrder = {
  ranks: Map<string, number | null>
  next: number
  replacement: boolean
}

function integerRank(key: string): number | undefined {
  const value = Number(key)
  return Number.isInteger(value) && value >= 0 && value < 4_294_967_295 && String(value) === key
    ? value
    : undefined
}

/** Rebuildable Record order; a candidate records only changed keys against the captured owner. */
export class SessionFieldOrder<Field extends string = SessionMapField> {
  private readonly fields = new Map<Field, FieldOrder>()

  constructor(private readonly prior?: SessionFieldOrder<Field>) {}

  candidate(): SessionFieldOrder<Field> {
    return new SessionFieldOrder(this)
  }

  private next(field: Field): number {
    return this.fields.get(field)?.next ?? this.prior?.next(field) ?? 0
  }

  private rank(field: Field, key: string): number | undefined {
    const current = this.fields.get(field)
    if (current?.ranks.has(key)) {
      return current.ranks.get(key) ?? undefined
    }
    return current?.replacement ? undefined : this.prior?.rank(field, key)
  }

  write(field: Field, key: string, present: boolean): void {
    let current = this.fields.get(field)
    if (!current) {
      current = { ranks: new Map(), next: this.next(field), replacement: false }
      this.fields.set(field, current)
    }
    const rank = this.rank(field, key)
    if (!present) {
      current.ranks.set(key, null)
    } else {
      // Coalesced edits overwrite a prior property; chronology requires a complete replacement.
      const retained = rank ?? (current.replacement ? undefined : this.prior?.rank(field, key))
      current.ranks.set(key, retained ?? current.next++)
    }
  }

  replace(field: Field, keys: readonly string[]): void {
    this.fields.set(field, {
      ranks: new Map(keys.map((key, index) => [key, index])),
      next: keys.length,
      replacement: true
    })
  }

  compare(field: Field, left: string, right: string): number {
    const a = integerRank(left),
      b = integerRank(right)
    if (a !== undefined || b !== undefined) {
      return a === undefined ? 1 : b === undefined ? -1 : a - b
    }
    // Removed addresses keep their prior rank for cleanup, without becoming candidate members.
    const leftRank = this.rank(field, left) ?? this.prior?.rank(field, left)
    const rightRank = this.rank(field, right) ?? this.prior?.rank(field, right)
    if (leftRank === undefined) {
      return rightRank === undefined ? 0 : 1
    }
    return rightRank === undefined ? -1 : leftRank - rightRank
  }

  ordered(field: Field, keys: Iterable<string>): string[] {
    return [...keys].sort((left, right) => this.compare(field, left, right))
  }
}
