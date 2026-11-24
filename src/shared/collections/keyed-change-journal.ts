/** Bounded derived invalidation history; lagging readers rebuild from the authoritative inputs. */
export class KeyedChangeJournal {
  private revision = 0
  private batches: (ReadonlySet<string> | null)[] = []

  cursor(): number {
    return this.revision
  }

  publish(keys: ReadonlySet<string> | null): void {
    if (keys?.size === 0) {
      return
    }
    this.revision++
    this.batches.push(keys && keys.size <= 4096 ? keys : null)
    if (this.batches.length > 16) {
      this.batches.shift()
    }
  }

  since(cursor: number): ReadonlySet<string> | null {
    const offset = cursor - (this.revision - this.batches.length)
    if (offset < 0 || cursor > this.revision) {
      return null
    }
    if (offset === this.batches.length - 1) {
      return this.batches[offset]!
    }
    const keys = new Set<string>()
    for (let index = offset; index < this.batches.length; index++) {
      const batch = this.batches[index]
      if (!batch) {
        return null
      }
      for (const key of batch) {
        keys.add(key)
      }
    }
    return keys
  }
}
