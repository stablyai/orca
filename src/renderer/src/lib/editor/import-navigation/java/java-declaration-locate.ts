import { javaCode } from './java-source-outline'

const MODIFIERS =
  'public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed'
const ANNOTATIONS = '(?:@[\\w$.]+(?:\\([^)]*\\))?\\s*)*'
const TYPE = '[\\w$][\\w$.]*(?:<[^;{}()=]*>)?(?:\\[\\])*'
// Statements that look like `<word> name(` but declare nothing.
const NOT_TYPES = new Set(['return', 'new', 'throw', 'else', 'case', 'yield', 'assert', 'do'])

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$')
}

/** Offset of `name` in the shallowest match of `pattern`, whose last group is the name. */
function shallowest(
  code: string,
  pattern: RegExp,
  name: string,
  accept: (match: RegExpExecArray) => boolean = () => true
): number | null {
  let best: { depth: number; offset: number } | null = null
  let depth = 0
  let scanned = 0
  for (const match of code.matchAll(pattern)) {
    for (; scanned < match.index; scanned += 1) {
      depth += code[scanned] === '{' ? 1 : code[scanned] === '}' ? -1 : 0
    }
    if (!accept(match)) {
      continue
    }
    const offset = match.index + match[0].lastIndexOf(name)
    if (!best || depth < best.depth) {
      best = { depth, offset }
    }
  }
  return best?.offset ?? null
}

export function locateJavaType(source: string, name: string): number | null {
  return shallowest(
    javaCode(source),
    new RegExp(
      `\\b(?:class|interface|enum|record|@interface)\\s+(${escapeName(name)})(?![\\w$])`,
      'g'
    ),
    name
  )
}

/** A method, field, nested type or enum constant named `name`, preferring class-body declarations. */
export function locateJavaMember(source: string, name: string): number | null {
  const code = javaCode(source)
  const escaped = escapeName(name)
  const declaresType = (match: RegExpExecArray): boolean =>
    !NOT_TYPES.has(match[1].split(/[<.[]/)[0])
  const nestedType = locateJavaType(source, name)
  if (nestedType !== null) {
    return nestedType
  }
  const method = shallowest(
    code,
    new RegExp(
      `^[ \\t]*${ANNOTATIONS}(?:(?:${MODIFIERS})\\s+)*(?:<[^>]*>\\s*)?(${TYPE})\\s+(${escaped})\\s*\\(`,
      'gm'
    ),
    name,
    declaresType
  )
  if (method !== null) {
    return method
  }
  const field = shallowest(
    code,
    new RegExp(
      `^[ \\t]*${ANNOTATIONS}(?:(?:${MODIFIERS})\\s+)*(${TYPE})\\s+(${escaped})\\s*(?:=|;|,)`,
      'gm'
    ),
    name,
    declaresType
  )
  if (field !== null || !/\benum\s/.test(code)) {
    return field
  }
  return shallowest(code, new RegExp(`^[ \\t]*(${escaped})\\s*(?=\\(|,|;|\\{|\\r?$)`, 'gm'), name)
}
