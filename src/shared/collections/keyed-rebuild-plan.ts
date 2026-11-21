import { KeyedDeadlines } from './keyed-deadlines'

/** A keyed change journal; the cursor advances when a batch of changed keys is published. */
export type KeyedChangeFeed = {
  changeCursor(): number
  /** Keys changed after `cursor`, or null when they are unknown. */
  changesSince(cursor: number): ReadonlySet<string> | null
}

export type KeyedRebuild = {
  feed: KeyedChangeFeed
  cursor: number
  inputs: readonly unknown[]
  now: number
  /** Keys to revisit; null means revisit every key. */
  dirty: ReadonlySet<string> | null
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Lets a keyed build revisit only journaled keys and keys whose wall-clock deadline passed. Any other input change, an unknown change set or a clock moving backwards rebuilds every key. */
export class KeyedRebuildPlan {
  /** Per-key instants after which the key's output changes; a key is due once `now` passes it. */
  readonly deadlines = new KeyedDeadlines()
  private completed: Omit<KeyedRebuild, 'dirty'> | null = null

  begin(feed: KeyedChangeFeed, inputs: readonly unknown[], now: number): KeyedRebuild {
    const cursor = feed.changeCursor()
    const previous = this.completed
    // An interrupted build must not be trusted by the next one.
    this.completed = null
    const changed =
      previous &&
      previous.feed === feed &&
      now >= previous.now &&
      sameItems(previous.inputs, inputs)
        ? feed.changesSince(previous.cursor)
        : null
    if (!changed) {
      this.deadlines.clear()
      return { feed, cursor, inputs, now, dirty: null }
    }
    const dirty = new Set(changed)
    for (const key of this.deadlines.takeDue(now)) {
      dirty.add(key)
    }
    return { feed, cursor, inputs, now, dirty }
  }

  /** Record a finished build; only then may the next build reuse its keys. */
  complete({ feed, cursor, inputs, now }: KeyedRebuild): void {
    this.completed = { feed, cursor, inputs, now }
  }

  reset(): void {
    this.completed = null
    this.deadlines.clear()
  }
}
