import { maskNonCodeText } from '../import-statement-scan'

export type JavaImport = {
  /** Dotted name without a trailing `.*`. */
  path: string
  isStatic: boolean
  wildcard: boolean
  pathStart: number
}

export type JavaTypeDeclaration = {
  name: string
  isEnum: boolean
  nameOffset: number
  /** Offsets of the body's `{` and its `}`; a body still being typed runs to the end. */
  bodyStart: number
  bodyEnd: number
  /** Braces open around the declaration; its members sit one deeper. */
  depth: number
  /** Names after `extends`/`implements`, without type arguments. */
  supertypes: string[]
  /** The type whose body holds this declaration; null at the top level. */
  parent: JavaTypeDeclaration | null
}

export type JavaSourceOutline = {
  /** The source with comments and literals blanked, offsets kept. */
  code: string
  packageName: string | null
  imports: JavaImport[]
  /** Every type the file declares, nested and local ones included, in source order. */
  types: JavaTypeDeclaration[]
}

const DOTTED_NAME = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
const PACKAGE = new RegExp(`\\bpackage\\s+(${DOTTED_NAME})\\s*;`)
const IMPORT = new RegExp(`\\bimport\\s+(static\\s+)?(${DOTTED_NAME})(\\.\\*)?\\s*;`, 'g')
const TYPE_DECLARATION = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g

function stripTypeArguments(text: string): string {
  let stripped = text
  while (/<[^<>]*>/.test(stripped)) {
    stripped = stripped.replace(/<[^<>]*>/g, '')
  }
  return stripped
}

function names(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => new RegExp(`^${DOTTED_NAME}$`).test(name))
}

function supertypesOf(header: string): string[] {
  const plain = stripTypeArguments(header).replace(/\([^)]*\)/g, ' ')
  const extendsList = /\bextends\s+([\s\S]*?)(?=\bimplements\b|\bpermits\b|$)/.exec(plain)?.[1]
  const implementsList = /\bimplements\s+([\s\S]*?)(?=\bpermits\b|$)/.exec(plain)?.[1]
  return [...names(extendsList), ...names(implementsList)]
}

/** The matching `}` and the enclosing brace depth of each `{` in `starts`. */
function bodyBraces(
  code: string,
  starts: ReadonlySet<number>
): Map<number, { end: number; depth: number }> {
  const bodies = new Map<number, { end: number; depth: number }>()
  const open: number[] = []
  for (let at = 0; at < code.length; at += 1) {
    if (code[at] === '{') {
      if (starts.has(at)) {
        bodies.set(at, { end: code.length, depth: open.length })
      }
      open.push(at)
    } else if (code[at] === '}') {
      const body = bodies.get(open.pop() ?? -1)
      if (body) {
        body.end = at
      }
    }
  }
  return bodies
}

function typeDeclarations(code: string): JavaTypeDeclaration[] {
  const headers = [...code.matchAll(TYPE_DECLARATION)].map((match) => {
    const nameOffset = match.index + match[0].length - match[2].length
    const open = code.indexOf('{', nameOffset)
    return { match, nameOffset, bodyStart: open === -1 ? code.length : open }
  })
  const bodies = bodyBraces(code, new Set(headers.map((header) => header.bodyStart)))
  const types: JavaTypeDeclaration[] = []
  for (const { match, nameOffset, bodyStart } of headers) {
    const body = bodies.get(bodyStart)
    types.push({
      name: match[2],
      isEnum: match[1] === 'enum',
      nameOffset,
      bodyStart,
      bodyEnd: body?.end ?? code.length,
      depth: body?.depth ?? 0,
      supertypes: supertypesOf(code.slice(nameOffset + match[2].length, bodyStart)),
      parent:
        types.findLast((type) => type.bodyStart < nameOffset && nameOffset < type.bodyEnd) ?? null
    })
  }
  return types
}

export function outlineJavaSource(source: string): JavaSourceOutline {
  // Why: Java shares JS comment and quote syntax, plus `"""` text blocks.
  const code = maskNonCodeText(source, { blankStrings: true, textBlocks: true })
  return {
    code,
    packageName: PACKAGE.exec(code)?.[1] ?? null,
    imports: [...code.matchAll(IMPORT)].map((match) => ({
      path: match[2],
      isStatic: match[1] !== undefined,
      wildcard: match[3] !== undefined,
      pathStart: match.index + match[0].indexOf(match[2], 'import'.length)
    })),
    types: typeDeclarations(code)
  }
}

/** Types whose bodies contain `offset`, innermost first. */
export function enclosingJavaTypes(
  outline: JavaSourceOutline,
  offset: number
): JavaTypeDeclaration[] {
  return outline.types
    .filter((type) => type.bodyStart < offset && offset < type.bodyEnd)
    .toReversed()
}

/**
 * The type `path` names when written at `offset`: its head declared in a type around `offset`,
 * innermost first, or at the top level, then each nested name inside the previous one.
 */
export function javaTypeAt(
  outline: JavaSourceOutline,
  [head, ...nested]: readonly string[],
  offset = -1
): JavaTypeDeclaration | null {
  let type: JavaTypeDeclaration | null = null
  for (const scope of [...enclosingJavaTypes(outline, offset), null]) {
    type =
      outline.types.find((candidate) => candidate.parent === scope && candidate.name === head) ??
      null
    if (type) {
      break
    }
  }
  for (const name of nested) {
    const scope = type
    type =
      scope &&
      (outline.types.find((candidate) => candidate.parent === scope && candidate.name === name) ??
        null)
  }
  return type
}

/** Fully qualified candidates for a type name used in this file, most likely first. */
export function javaTypeCandidates(outline: JavaSourceOutline, typeName: string): string[] {
  const [head, ...rest] = typeName.split('.')
  const suffix = rest.length > 0 ? `.${rest.join('.')}` : ''
  if (/^[a-z]/.test(head) && rest.length > 0) {
    // Why: a lowercase head is a package, so the name is already fully qualified.
    return [typeName]
  }
  const explicit = outline.imports.find(
    (entry) => !entry.wildcard && entry.path.split('.').at(-1) === head
  )
  if (explicit) {
    return [explicit.path + suffix]
  }
  const samePackage = outline.packageName ? `${outline.packageName}.${typeName}` : typeName
  const wildcards = outline.imports
    .filter((entry) => entry.wildcard && !entry.isStatic)
    .map((entry) => `${entry.path}.${typeName}`)
  return [samePackage, ...wildcards]
}
