import { matchRefPattern } from './git-fetch-refspec'

export type GitFetchEffectRow = { name: string; spec: string; url: string }
export type GitRefFact = {
  ref: string
  oid: string
  symref: string
  upstream?: string
  remote?: string
  source?: string
  head?: string
}

export function indexGitRefs(
  refs: readonly GitRefFact[]
): (pattern: string, first?: boolean) => GitRefFact[] {
  const sorted = [...refs].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  const exact = new Map(refs.map((row) => [row.ref, row]))
  return (pattern, first = false) => {
    const prefix = pattern.split('*')[0]
    const wildcard = pattern.includes('*')
    const found: GitRefFact[] = []
    const row = exact.get(prefix)
    if (!wildcard && row) {
      found.push(row)
      if (first) {
        return found
      }
    }
    const scan = wildcard ? prefix : `${prefix}/`
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid].ref < scan) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    for (let i = lo; i < sorted.length && sorted[i].ref.startsWith(scan); i += 1) {
      if (!wildcard || matchRefPattern(pattern, sorted[i].ref) !== null) {
        found.push(sorted[i])
        if (first) {
          return found
        }
      }
    }
    for (let i = prefix.indexOf('/'); i >= 0; i = prefix.indexOf('/', i + 1)) {
      const ancestor = exact.get(prefix.slice(0, i))
      if (ancestor) {
        found.push(ancestor)
        if (first) {
          return found
        }
      }
    }
    return found
  }
}

/** Each wildcard is stored once; exact sources never scan unrelated earlier sources. */
export function createSourceCoverageIndex() {
  type Node = { next: Map<string, Node>; suffix?: Node; terminal?: boolean }
  const node = (): Node => ({ next: new Map() })
  const root = node()
  const exact = new Set<string>()
  const insert = (start: Node, text: string): Node => {
    let current = start
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]
      let next = current.next.get(char)
      if (!next) {
        next = node()
        current.next.set(char, next)
      }
      current = next
    }
    return current
  }
  const reversed = (text: string) => text.split('').toReversed().join('')
  return {
    add(source: string) {
      if (!source.includes('*')) {
        exact.add(source)
        return
      }
      const [prefix, suffix] = source.split('*')
      const terminal = insert(root, prefix)
      terminal.suffix ??= node()
      insert(terminal.suffix, reversed(suffix)).terminal = true
    },
    covers(source: string): boolean {
      const wildcard = source.includes('*')
      if (!wildcard && exact.has(source)) {
        return true
      }
      const [prefix, suffix] = wildcard ? source.split('*') : [source, source]
      const tail = reversed(suffix)
      let current: Node | undefined = root
      for (let i = 0; current && i <= prefix.length; i += 1) {
        let end = current.suffix
        for (let j = 0; end; j += 1) {
          if (end.terminal && (wildcard || i + j <= source.length)) {
            return true
          }
          if (j === tail.length) {
            break
          }
          end = end.next.get(tail[j])
        }
        current = current.next.get(prefix[i])
      }
      return false
    }
  }
}
