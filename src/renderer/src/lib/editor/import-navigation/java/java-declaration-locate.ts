import {
  enclosingJavaTypes,
  type JavaSourceOutline,
  type JavaTypeDeclaration
} from './java-source-outline'

const MODIFIERS =
  'public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed'
const ANNOTATIONS = '(?:@[\\w$.]+(?:\\([^)]*\\))?\\s*)*'
const TYPE = '[\\w$][\\w$.]*(?:<[^;{}()=]*>)?(?:\\[\\])*'
// Statements that look like `<word> name(` but declare nothing.
const NOT_TYPES = new Set(['return', 'new', 'throw', 'else', 'case', 'yield', 'assert', 'do'])

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$')
}

function declaresType(match: RegExpExecArray): boolean {
  return !NOT_TYPES.has(match[1].split(/[<.[]/)[0])
}

// A declaration starts a line or follows `{`, `;` or `}`, as in `class Pair { int left() {} }`.
const DECLARATION_START = '(?<=^|[{};])[ \\t]*'

function methodPattern(name: string): RegExp {
  return new RegExp(
    `${DECLARATION_START}${ANNOTATIONS}(?:(?:${MODIFIERS})\\s+)*(?:<[^>]*>\\s*)?(${TYPE})\\s+(${escapeName(name)})\\s*\\(`,
    'gm'
  )
}

function variablePattern(name: string): RegExp {
  return new RegExp(
    `${DECLARATION_START}${ANNOTATIONS}(?:(?:${MODIFIERS})\\s+)*(${TYPE})\\s+(${escapeName(name)})\\s*(?:=|;|,)`,
    'gm'
  )
}

function nameOffset(match: RegExpExecArray, name: string): number {
  return match.index + match[0].lastIndexOf(name)
}

/** Brace and parenthesis nesting at increasing offsets inside `type`'s body. */
function bodyNesting(
  code: string,
  type: JavaTypeDeclaration
): (at: number) => { braces: number; parens: number } {
  let scanned = type.bodyStart + 1
  let braces = 0
  let parens = 0
  return (at) => {
    for (; scanned < at; scanned += 1) {
      const char = code[scanned]
      braces += char === '{' ? 1 : char === '}' ? -1 : 0
      parens += char === '(' ? 1 : char === ')' ? -1 : 0
    }
    return { braces, parens }
  }
}

/** First match of `pattern` declared directly in `type`'s body, outside its methods and parameter lists. */
function firstMember(
  code: string,
  type: JavaTypeDeclaration,
  pattern: RegExp,
  accept: (match: RegExpExecArray) => boolean = () => true
): RegExpExecArray | null {
  const nesting = bodyNesting(code, type)
  pattern.lastIndex = type.bodyStart + 1
  let match = pattern.exec(code)
  while (match && match.index < type.bodyEnd) {
    const { braces, parens } = nesting(match.index)
    if (braces === 0 && parens === 0 && accept(match)) {
      return match
    }
    match = pattern.exec(code)
  }
  return null
}

/** Offset of `name` declared directly in `type`: a nested type, method, field or enum constant. */
export function locateJavaMember(
  outline: JavaSourceOutline,
  type: JavaTypeDeclaration,
  name: string
): number | null {
  const { code } = outline
  const declaration =
    firstMember(
      code,
      type,
      new RegExp(`\\b(?:class|interface|enum|record)\\s+(${escapeName(name)})(?![\\w$])`, 'g')
    ) ??
    firstMember(code, type, methodPattern(name), declaresType) ??
    firstMember(code, type, variablePattern(name), declaresType)
  if (declaration) {
    return nameOffset(declaration, name)
  }
  if (!type.isEnum) {
    return null
  }
  // Why: constants open an enum body and end at its first member-level `;`.
  const constant = firstMember(
    code,
    type,
    new RegExp(`(?<![\\w$.@])${escapeName(name)}(?![\\w$])|;`, 'g')
  )
  return constant && constant[0] !== ';' ? constant.index : null
}

/** Offset of `name` among the parameters of the method or constructor whose body holds `offset`. */
function locateJavaParameter(
  code: string,
  type: JavaTypeDeclaration,
  name: string,
  offset: number
): number | null {
  let headerStart = type.bodyStart + 1
  let blockStart = -1
  let depth = 0
  for (let at = type.bodyStart + 1; at < offset; at += 1) {
    const char = code[at]
    if (char === '{') {
      if (depth === 0) {
        blockStart = at
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        headerStart = at + 1
      }
    } else if (char === ';' && depth === 0) {
      headerStart = at + 1
    }
  }
  if (depth <= 0) {
    return null
  }
  const parameter = new RegExp(
    `[(,]\\s*${ANNOTATIONS}(?:final\\s+)?${ANNOTATIONS}${TYPE}\\s+(${escapeName(name)})\\s*(?=[,)])`
  ).exec(code.slice(headerStart, blockStart))
  return parameter ? headerStart + nameOffset(parameter, name) : null
}

/** Offset of the local variable or parameter `name` that is in scope at `offset`. */
export function locateJavaLocal(
  outline: JavaSourceOutline,
  name: string,
  offset: number
): number | null {
  const { code } = outline
  const declarations = [...code.matchAll(variablePattern(name))].filter(
    (match) => match.index < offset && declaresType(match)
  )
  // Locals whose block is still open, nearest last; their depths never decrease.
  const inScope: { offset: number; depth: number }[] = []
  let depth = 0
  let next = 0
  for (let at = 0; at < offset; at += 1) {
    for (; declarations[next]?.index === at; next += 1) {
      const owner = enclosingJavaTypes(outline, at)[0]
      // Why: one brace into a type body is a field, or a parameter checked below.
      if (owner && depth > owner.depth + 1) {
        inScope.push({ offset: nameOffset(declarations[next], name), depth })
      }
    }
    if (code[at] === '{') {
      depth += 1
    } else if (code[at] === '}') {
      // Why: a stray `}` closes no block; below zero the pop loop would never end.
      depth = Math.max(0, depth - 1)
      while ((inScope.at(-1)?.depth ?? -1) > depth) {
        inScope.pop()
      }
    }
  }
  const type = enclosingJavaTypes(outline, offset)[0]
  return inScope.at(-1)?.offset ?? (type ? locateJavaParameter(code, type, name, offset) : null)
}
