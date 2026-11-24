export class CoordinatorIdentityOwners<T> {
  private readonly owners = new Map<string, { value: T; duplicates?: Set<T> }>()

  constructor(private readonly later: (left: T, right: T) => boolean) {}

  add(key: string, entry: T): void {
    const owner = this.owners.get(key)
    if (!owner) {
      this.owners.set(key, { value: entry })
    } else if (owner.duplicates) {
      owner.duplicates.add(entry)
    } else if (owner.value !== entry) {
      owner.duplicates = new Set([owner.value, entry])
    }
  }

  remove(key: string, entry: T): void {
    const owner = this.owners.get(key)
    if (!owner) {
      return
    }
    if (!owner.duplicates) {
      if (owner.value === entry) {
        this.owners.delete(key)
      }
      return
    }
    owner.duplicates.delete(entry)
    if (owner.duplicates.size === 1) {
      for (const remaining of owner.duplicates) {
        owner.value = remaining
      }
      owner.duplicates = undefined
    }
  }

  get(key: string): T | undefined {
    const owner = this.owners.get(key)
    if (owner?.duplicates) {
      let first = true
      for (const entry of owner.duplicates) {
        if (first || this.later(entry, owner.value)) {
          owner.value = entry
          first = false
        }
      }
    }
    return owner?.value
  }

  forEach(key: string, visit: (entry: T) => void): void {
    const owner = this.owners.get(key)
    if (owner?.duplicates) {
      owner.duplicates.forEach(visit)
    } else if (owner) {
      visit(owner.value)
    }
  }
}
