import { maskNonCodeText } from '../import-statement-scan'

export type JavaImport = {
  /** Dotted name without a trailing `.*`. */
  path: string
  isStatic: boolean
  wildcard: boolean
  pathStart: number
}

export type JavaSourceOutline = {
  packageName: string | null
  imports: JavaImport[]
  /** Names after `extends`/`implements` of the first top-level type, without type arguments. */
  supertypes: string[]
  /** Simple names of the types this file declares, nested ones included. */
  declaredTypes: Set<string>
}

const DOTTED_NAME = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
const PACKAGE = new RegExp(`\\bpackage\\s+(${DOTTED_NAME})\\s*;`)
const IMPORT = new RegExp(`\\bimport\\s+(static\\s+)?(${DOTTED_NAME})(\\.\\*)?\\s*;`, 'g')
const TYPE_DECLARATION = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g

/** Comments and string literals blanked, offsets kept; Java shares JS comment and quote syntax. */
export function javaCode(source: string): string {
  return maskNonCodeText(source, { blankStrings: true })
}

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

function topLevelSupertypes(code: string): string[] {
  let depth = 0
  let scanned = 0
  for (const match of code.matchAll(TYPE_DECLARATION)) {
    for (; scanned < match.index; scanned += 1) {
      depth += code[scanned] === '{' ? 1 : code[scanned] === '}' ? -1 : 0
    }
    if (depth !== 0) {
      continue
    }
    const headerEnd = code.indexOf('{', match.index)
    const header = stripTypeArguments(
      code.slice(match.index + match[0].length, headerEnd === -1 ? undefined : headerEnd)
    ).replace(/\([^)]*\)/g, ' ')
    const extendsList = /\bextends\s+([\s\S]*?)(?=\bimplements\b|\bpermits\b|$)/.exec(header)?.[1]
    const implementsList = /\bimplements\s+([\s\S]*?)(?=\bpermits\b|$)/.exec(header)?.[1]
    return [...names(extendsList), ...names(implementsList)]
  }
  return []
}

export function outlineJavaSource(source: string): JavaSourceOutline {
  const code = javaCode(source)
  return {
    packageName: PACKAGE.exec(code)?.[1] ?? null,
    imports: [...code.matchAll(IMPORT)].map((match) => ({
      path: match[2],
      isStatic: match[1] !== undefined,
      wildcard: match[3] !== undefined,
      pathStart: match.index + match[0].indexOf(match[2], 'import'.length)
    })),
    supertypes: topLevelSupertypes(code),
    declaredTypes: new Set([...code.matchAll(TYPE_DECLARATION)].map((match) => match[1]))
  }
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
