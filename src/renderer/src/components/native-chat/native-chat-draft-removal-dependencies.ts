type Fact = { ready: boolean; waiting: (() => void)[] }

/** One finite candidate join; each fact wakes its actual dependents once. */
export function nativeChatDraftRemovalDependencies() {
  const work: (() => void)[] = []
  const fact = (ready = false): Fact => ({ ready, waiting: [] })
  const provide = (value: Fact) => {
    if (!value.ready) {
      value.ready = true
      for (const apply of value.waiting) {
        work.push(apply)
      }
      value.waiting.length = 0
    }
  }
  const all = (inputs: readonly Fact[], apply: () => void) => {
    const pending = [...new Set(inputs)].filter((input) => !input.ready)
    if (!pending.length) {
      work.push(apply)
      return
    }
    let remaining = pending.length
    for (const input of pending) {
      input.waiting.push(() => {
        remaining -= 1
        if (!remaining) {
          work.push(apply)
        }
      })
    }
  }
  return {
    fact,
    all,
    any(inputs: readonly Fact[]) {
      const result = fact(inputs.some((input) => input.ready))
      if (!result.ready) {
        for (const input of inputs) {
          input.waiting.push(() => provide(result))
        }
      }
      return result
    },
    index<T>(known: Set<T>) {
      const facts = new Map<T, Fact>()
      return {
        get(value: T) {
          let held = facts.get(value)
          if (!held) {
            held = fact(known.has(value))
            facts.set(value, held)
          }
          return held
        },
        add(value: T) {
          known.add(value)
          const held = facts.get(value)
          if (held) {
            provide(held)
          }
        }
      }
    },
    drain() {
      for (let at = 0; at < work.length; at += 1) {
        work[at]()
      }
      work.length = 0
    }
  }
}
