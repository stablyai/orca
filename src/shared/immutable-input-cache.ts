/** Every co-input is weak: a surviving sibling cannot retain an obsolete input generation. */
export class ImmutableInputCache<Value> {
  private readonly next = new WeakMap<object, ImmutableInputCache<Value>>()
  private readonly values = new Map<string, Value>()

  private leaf(inputs: readonly object[]): ImmutableInputCache<Value> {
    return inputs.reduce<ImmutableInputCache<Value>>((node, input) => {
      let child = node.next.get(input)
      if (!child) {
        child = new ImmutableInputCache<Value>()
        node.next.set(input, child)
      }
      return child
    }, this)
  }

  get(inputs: readonly object[], key: string): Value | undefined {
    return this.leaf(inputs).values.get(key)
  }

  set(inputs: readonly object[], key: string, value: Value): void {
    this.leaf(inputs).values.set(key, value)
  }
}

export const absentImmutableInput = Object.freeze({})
