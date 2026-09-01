// Recursively scans a client-crossing value (agent catalog projection, launch
// receipt, rendered notice copy) for configured custom-env leakage. A single
// JSON substring check can be fooled — a value split across sibling fields, or an
// env key that only ever appears as an object key — so this walks every string
// (object keys included) at any depth and reports each forbidden term it finds.
// G7 oracle-12/13 hardening: tests build the forbidden terms from a definition's
// env keys+values (deliberately distinctive so they cannot collide with legitimate
// ids/labels/args) and assert the returned array is empty.

export type CustomEnvLeak = { term: string; at: string }

export function scanForCustomEnvLeak(
  root: unknown,
  forbiddenTerms: readonly string[]
): CustomEnvLeak[] {
  const terms = forbiddenTerms.filter((term) => term.length > 0)
  const leaks: CustomEnvLeak[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const term of terms) {
        if (value.includes(term)) {
          leaks.push({ term, at: path })
        }
      }
      return
    }
    // Visit each object once: a cyclic graph or shared reference would otherwise
    // recurse until the stack overflows.
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (value instanceof Set) {
      // A forbidden term can hide as a Set member (e.g. a serialized allowlist).
      let index = 0
      for (const item of value) {
        visit(item, `${path}<set:${index}>`)
        index += 1
      }
      return
    }
    if (value instanceof Map) {
      for (const [key, child] of value.entries()) {
        visit(key, `${path}<key>`)
        visit(child, `${path}.${String(key)}`)
      }
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        // An env key can leak as an OBJECT KEY, not only inside a string value.
        for (const term of terms) {
          if (key.includes(term)) {
            leaks.push({ term, at: `${path}.${key} (key)` })
          }
        }
        visit(child, `${path}.${key}`)
      }
    }
  }
  visit(root, '$')
  return leaks
}
