import { javaCode, javaTypeCandidates, type JavaSourceOutline } from './java-source-outline'

export type JavaNavigationRequest = {
  /** Fully qualified types to open, most likely first; empty when only a member is named. */
  types: string[]
  /** Member or nested type to land on; null lands on the type itself. */
  member: string | null
  /** Types an unqualified member may come from through `import static …*`. */
  staticTypes: string[]
  /** Look for the member in this file, then up its `extends`/`implements` chain. */
  searchHierarchy: boolean
  /** `super.name`: skip this file's own declaration. */
  skipCurrentFile: boolean
}

const IDENTIFIER_CHAR = /[\w$]/
const KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double else ' +
    'enum extends final finally float for goto if implements import instanceof int interface long ' +
    'native new package private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while var record yield sealed permits ' +
    'true false null'
  ).split(' ')
)

function wordAt(code: string, offset: number): { word: string; start: number } | null {
  let start = offset
  let end = offset
  while (start > 0 && IDENTIFIER_CHAR.test(code[start - 1])) {
    start -= 1
  }
  while (end < code.length && IDENTIFIER_CHAR.test(code[end])) {
    end += 1
  }
  const word = code.slice(start, end)
  return /^[A-Za-z_$]/.test(word) ? { word, start } : null
}

/** The dotted chain written before `start`, e.g. `com.example.Foo` for `com.example.Foo.bar`. */
function qualifierBefore(code: string, start: number): string | null {
  let at = start - 1
  while (at >= 0 && /\s/.test(code[at])) {
    at -= 1
  }
  if (code[at] !== '.') {
    return null
  }
  const before = code.slice(0, at)
  return (
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/.exec(before)?.[1].replace(/\s+/g, '') ??
    null
  )
}

function isConstantName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && /[_0-9]/.test(name)
}

function typeRequest(types: string[], member: string | null): JavaNavigationRequest {
  return { types, member, staticTypes: [], searchHierarchy: false, skipCurrentFile: false }
}

function importRequest(
  outline: JavaSourceOutline,
  offset: number
): JavaNavigationRequest | null | undefined {
  const entry = outline.imports.find(
    (candidate) =>
      offset >= candidate.pathStart && offset < candidate.pathStart + candidate.path.length
  )
  if (!entry) {
    return undefined
  }
  const segments = entry.path.split('.')
  let segmentEnd = entry.pathStart
  const clicked = segments.findIndex((segment) => {
    segmentEnd += segment.length + 1
    return offset < segmentEnd
  })
  const typeIndex = segments.findIndex((segment) => /^[A-Z]/.test(segment))
  if (typeIndex === -1 || clicked < typeIndex) {
    return null
  }
  return typeRequest(
    [segments.slice(0, typeIndex + 1).join('.')],
    clicked > typeIndex ? segments[clicked] : null
  )
}

/** What a Go to Definition request at `offset` in a Java file should open, or null. */
export function findJavaNavigationRequest(
  source: string,
  outline: JavaSourceOutline,
  offset: number
): JavaNavigationRequest | null {
  const fromImport = importRequest(outline, offset)
  if (fromImport !== undefined) {
    return fromImport
  }
  const code = javaCode(source)
  const target = wordAt(code, offset)
  if (!target) {
    return null
  }
  const { word, start } = target
  if (KEYWORDS.has(word)) {
    return null
  }
  const qualifier = qualifierBefore(code, start)
  if (qualifier === 'this' || qualifier === 'super') {
    return {
      types: [],
      member: word,
      staticTypes: [],
      searchHierarchy: true,
      skipCurrentFile: qualifier === 'super'
    }
  }
  if (qualifier) {
    const segments = qualifier.split('.')
    // Why: a lowercase last qualifier is a variable whose type is unknown without a language server.
    if (/^[A-Z]/.test(segments.at(-1) ?? '')) {
      return typeRequest(javaTypeCandidates(outline, qualifier), word)
    }
    return segments.every((segment) => /^[a-z]/.test(segment)) && /^[A-Z]/.test(word)
      ? typeRequest([`${qualifier}.${word}`], null)
      : null
  }
  const staticImport = outline.imports.find(
    (entry) => entry.isStatic && !entry.wildcard && entry.path.split('.').at(-1) === word
  )
  if (staticImport) {
    return typeRequest([staticImport.path.split('.').slice(0, -1).join('.')], word)
  }
  if (/^[A-Z]/.test(word) && !isConstantName(word)) {
    return outline.declaredTypes.has(word)
      ? { types: [], member: word, staticTypes: [], searchHierarchy: true, skipCurrentFile: false }
      : typeRequest(javaTypeCandidates(outline, word), null)
  }
  return {
    types: [],
    member: word,
    staticTypes: outline.imports
      .filter((entry) => entry.isStatic && entry.wildcard)
      .map((entry) => entry.path),
    searchHierarchy: true,
    skipCurrentFile: false
  }
}
