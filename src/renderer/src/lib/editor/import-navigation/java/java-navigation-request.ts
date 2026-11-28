import { javaTypeAt, type JavaSourceOutline } from './java-source-outline'

/** A type as written in the file; lands on `member` in it or its supertypes, else on the type. */
export type JavaTypeLookup = { kind: 'type'; type: string; member: string | null }

/** A simple name looked up from the cursor outwards: locals, enclosing types, their supertypes. */
export type JavaNameLookup = {
  kind: 'name'
  name: string
  /** `this.name` searches the innermost type and its supertypes; `super.name` only the supertypes. */
  receiver: 'this' | 'super' | null
  /** Types the name may come from through `import static`, tried last. */
  staticTypes: string[]
}

export type JavaNavigationRequest = {
  /** Where the name is used; it resolves in the scope around this offset. */
  offset: number
  /** Tried in order until one finds a declaration. */
  lookups: (JavaTypeLookup | JavaNameLookup)[]
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

function typeLookup(type: string, member: string | null): JavaTypeLookup {
  return { kind: 'type', type, member }
}

function importLookups(
  outline: JavaSourceOutline,
  offset: number
): JavaTypeLookup[] | null | undefined {
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
  // Why: a segment past the type names a member of the one before it, e.g. `NAME` of `Outer.Inner`.
  return clicked > typeIndex
    ? [typeLookup(segments.slice(0, clicked).join('.'), segments[clicked])]
    : [typeLookup(segments.slice(0, typeIndex + 1).join('.'), null)]
}

function lookupsAt(
  outline: JavaSourceOutline,
  offset: number
): JavaNavigationRequest['lookups'] | null {
  const fromImport = importLookups(outline, offset)
  if (fromImport !== undefined) {
    return fromImport
  }
  const target = wordAt(outline.code, offset)
  if (!target || KEYWORDS.has(target.word)) {
    return null
  }
  const { word, start } = target
  const qualifier = qualifierBefore(outline.code, start)
  if (qualifier === 'this' || qualifier === 'super') {
    return [{ kind: 'name', name: word, receiver: qualifier, staticTypes: [] }]
  }
  if (qualifier) {
    const segments = qualifier.split('.')
    // Why: a lowercase last qualifier is a variable whose type is unknown without a language server.
    if (/^[A-Z]/.test(segments.at(-1) ?? '')) {
      return [typeLookup(qualifier, word)]
    }
    return segments.every((segment) => /^[a-z]/.test(segment)) && /^[A-Z]/.test(word)
      ? [typeLookup(`${qualifier}.${word}`, null)]
      : null
  }
  const singleStatic = outline.imports
    .filter((entry) => entry.isStatic && !entry.wildcard && entry.path.split('.').at(-1) === word)
    .map((entry) => entry.path.split('.').slice(0, -1).join('.'))
  const nameLookup: JavaNameLookup = {
    kind: 'name',
    name: word,
    receiver: null,
    // Why: a single static import shadows the on-demand ones for its name.
    staticTypes:
      singleStatic.length > 0
        ? singleStatic
        : outline.imports
            .filter((entry) => entry.isStatic && entry.wildcard)
            .map((entry) => entry.path)
  }
  if (!/^[A-Z]/.test(word) || singleStatic.length > 0 || javaTypeAt(outline, [word], offset)) {
    return [nameLookup]
  }
  // Why: an all-caps name is usually a constant, so a type such as `URL` comes second; any other
  // capitalized name is a type first, else a member type inherited from a supertype.
  return /^[A-Z][A-Z0-9_]*$/.test(word)
    ? [nameLookup, typeLookup(word, null)]
    : [typeLookup(word, null), nameLookup]
}

/** What a Go to Definition request at `offset` in a Java file should look up, or null. */
export function findJavaNavigationRequest(
  outline: JavaSourceOutline,
  offset: number
): JavaNavigationRequest | null {
  const lookups = lookupsAt(outline, offset)
  return lookups ? { offset, lookups } : null
}
