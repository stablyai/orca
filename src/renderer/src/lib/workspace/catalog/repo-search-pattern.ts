const OR_SEPARATOR = '||'
const WILDCARD = '*'

// Escape every regex syntax char so only `*` acts as a wildcard.
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')
}

function wildcardTermToRegExp(term: string): RegExp {
  return new RegExp(term.split(WILDCARD).map(escapeRegExp).join('[\\s\\S]*?'), 'u')
}

export type RepoSearchPattern = (text: string) => number

// Returns a matcher giving the first match index (or -1). Plain queries keep substring semantics.
export function compileRepoSearchPattern(query: string): RepoSearchPattern {
  if (!query.includes(OR_SEPARATOR) && !query.includes(WILDCARD)) {
    return (text) => text.indexOf(query)
  }
  const terms = query
    .split(OR_SEPARATOR)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
  if (terms.length === 0) {
    return () => -1
  }
  const matchers = terms.map((term): RepoSearchPattern => {
    if (!term.includes(WILDCARD)) {
      return (text) => text.indexOf(term)
    }
    const regex = wildcardTermToRegExp(term)
    return (text) => text.search(regex)
  })
  return (text) => {
    let best = -1
    for (const match of matchers) {
      const index = match(text)
      if (index !== -1 && (best === -1 || index < best)) {
        best = index
      }
    }
    return best
  }
}
