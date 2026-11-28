import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { resolveModulePath } from '../import-module-candidates'
import type { ImportNavigationFileAccess } from '../import-navigation-file-access'
import type { ImportNavigationTarget } from '../import-target-resolution'
import { locateJavaLocal, locateJavaMember } from './java-declaration-locate'
import type {
  JavaNameLookup,
  JavaNavigationRequest,
  JavaTypeLookup
} from './java-navigation-request'
import {
  enclosingJavaTypes,
  javaTypeAt,
  javaTypeCandidates,
  outlineJavaSource,
  type JavaSourceOutline,
  type JavaTypeDeclaration
} from './java-source-outline'

type JavaFile = { filePath: string; content: string; outline: JavaSourceOutline }

/** A resolved type name; `type` is null when its file has no such declaration. */
type JavaTypeInFile = { file: JavaFile; type: JavaTypeDeclaration | null }

type JavaSearch = {
  access: ImportNavigationFileAccess
  rootPath: string
  remainingFiles: number
  visited: Set<string>
}

// Bounds supertype walks and fallbacks so one click reads a handful of files at most.
const MAX_FOLLOWED_FILES = 12
const MAX_SUPERTYPE_DEPTH = 4

function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The source root `fromFile` sits in, from its package, plus the main/test sibling root. */
function sourceRoots(fromFile: JavaFile): string[] {
  const directory = dirname(fromFile.filePath)
  const packagePath = fromFile.outline.packageName?.split('.').join('/') ?? ''
  const normalized = forwardSlashes(directory)
  if (packagePath && !normalized.endsWith(`/${packagePath}`)) {
    return []
  }
  const root = packagePath
    ? directory.slice(0, directory.length - packagePath.length - 1)
    : directory
  const sibling = root.replace(
    /([\\/])src\1(main|test)\1java$/,
    (_, separator: string, kind: string) =>
      ['', 'src', kind === 'main' ? 'test' : 'main', 'java'].join(separator)
  )
  return sibling === root ? [root] : [root, sibling]
}

function sharedPrefixLength(left: string, right: string): number {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1
  }
  return index
}

async function readJavaFile(search: JavaSearch, filePath: string): Promise<JavaFile | null> {
  if (search.remainingFiles <= 0 || getRelativePathInsideRoot(filePath, search.rootPath) === null) {
    return null
  }
  search.remainingFiles -= 1
  const content = await search.access.readText(filePath)
  return content === null ? null : { filePath, content, outline: outlineJavaSource(content) }
}

/** The file declaring the top-level type of `qualifiedName`, plus the type path from it. */
async function resolveTypeFile(
  search: JavaSearch,
  fromFile: JavaFile,
  qualifiedName: string
): Promise<{ file: JavaFile; path: string[] } | null> {
  const segments = qualifiedName.split('.')
  const typeIndex = Math.max(
    0,
    segments.findIndex((segment) => /^[A-Z]/.test(segment))
  )
  const fileName = `${segments[typeIndex]}.java`
  const relativePath = [...segments.slice(0, typeIndex), fileName].join('/')
  const path = segments.slice(typeIndex)
  const candidates = sourceRoots(fromFile)
    .map((root) => resolveModulePath(root, relativePath))
    .filter((candidate) => getRelativePathInsideRoot(candidate, search.rootPath) !== null)
  const exists = candidates.length > 0 ? await search.access.pathsExist(candidates) : []
  for (const [index, candidate] of candidates.entries()) {
    const file = exists[index] ? await readJavaFile(search, candidate) : null
    if (file) {
      return { file, path }
    }
  }
  // Why: another module (e.g. Gradle's core/src/main/java) holds the type; find it by name.
  const named = (await search.access.findFilesNamed?.(fileName)) ?? []
  const matches = named
    .filter((filePath) => forwardSlashes(filePath).endsWith(`/${relativePath}`))
    .sort(
      (a, b) => sharedPrefixLength(b, fromFile.filePath) - sharedPrefixLength(a, fromFile.filePath)
    )
  for (const match of matches.slice(0, 3)) {
    const file = await readJavaFile(search, match)
    if (file) {
      return { file, path }
    }
  }
  return null
}

/** The type a name written at `offset` in `fromFile` refers to: declared there, else imported. */
async function resolveType(
  search: JavaSearch,
  fromFile: JavaFile,
  name: string,
  offset: number
): Promise<JavaTypeInFile | null> {
  const declared = javaTypeAt(fromFile.outline, name.split('.'), offset)
  if (declared) {
    return { file: fromFile, type: declared }
  }
  for (const qualifiedName of javaTypeCandidates(fromFile.outline, name)) {
    const resolved = await resolveTypeFile(search, fromFile, qualifiedName)
    if (resolved) {
      return { file: resolved.file, type: javaTypeAt(resolved.file.outline, resolved.path) }
    }
  }
  return null
}

function target(file: JavaFile, offset: number | null): ImportNavigationTarget {
  return { filePath: file.filePath, content: file.content, offset: offset ?? 0 }
}

async function memberInHierarchy(
  search: JavaSearch,
  file: JavaFile,
  type: JavaTypeDeclaration,
  member: string,
  skipOwn: boolean,
  depth: number
): Promise<ImportNavigationTarget | null> {
  const key = `${file.filePath}\0${type.nameOffset}`
  if (search.visited.has(key)) {
    return null
  }
  search.visited.add(key)
  const own = skipOwn ? null : locateJavaMember(file.outline, type, member)
  if (own !== null) {
    return target(file, own)
  }
  if (depth >= MAX_SUPERTYPE_DEPTH) {
    return null
  }
  for (const supertype of type.supertypes) {
    // Why: a supertype name resolves where it is written, around the subtype's declaration.
    const resolved = await resolveType(search, file, supertype, type.nameOffset)
    const found = resolved?.type
      ? await memberInHierarchy(search, resolved.file, resolved.type, member, false, depth + 1)
      : null
    if (found) {
      return found
    }
  }
  return null
}

async function openType(
  search: JavaSearch,
  current: JavaFile,
  offset: number,
  lookup: JavaTypeLookup
): Promise<ImportNavigationTarget | null> {
  const resolved = await resolveType(search, current, lookup.type, offset)
  if (!resolved) {
    return null
  }
  const member =
    lookup.member && resolved.type
      ? await memberInHierarchy(search, resolved.file, resolved.type, lookup.member, false, 0)
      : null
  return member ?? target(resolved.file, resolved.type?.nameOffset ?? null)
}

async function lookUpName(
  search: JavaSearch,
  current: JavaFile,
  offset: number,
  { name, receiver, staticTypes }: JavaNameLookup
): Promise<ImportNavigationTarget | null> {
  const enclosing = enclosingJavaTypes(current.outline, offset)
  if (!receiver) {
    const local = locateJavaLocal(current.outline, name, offset)
    if (local !== null) {
      return target(current, local)
    }
  }
  // Why: `this.` and `super.` name the innermost type's members; a simple name may be an outer
  // one's, but a type's inherited members shadow those of the types around it.
  for (const scope of receiver ? enclosing.slice(0, 1) : enclosing) {
    const member = await memberInHierarchy(search, current, scope, name, receiver === 'super', 0)
    if (member) {
      return member
    }
  }
  const declared = receiver ? null : javaTypeAt(current.outline, [name], offset)
  if (declared) {
    return target(current, declared.nameOffset)
  }
  // Why: members of the file and its supertypes shadow names brought in with `import static`.
  for (const staticType of staticTypes) {
    const resolved = await resolveType(search, current, staticType, offset)
    const found = resolved?.type
      ? await memberInHierarchy(search, resolved.file, resolved.type, name, false, 0)
      : null
    if (found) {
      return found
    }
  }
  return null
}

/** Opens the type, member or supertype member a Java navigation request names, without a language server. */
export async function resolveJavaNavigationTarget(
  access: ImportNavigationFileAccess,
  params: { filePath: string; rootPath: string; content: string; outline: JavaSourceOutline },
  request: JavaNavigationRequest
): Promise<ImportNavigationTarget | null> {
  const search: JavaSearch = {
    access,
    rootPath: params.rootPath,
    remainingFiles: MAX_FOLLOWED_FILES,
    visited: new Set()
  }
  const current: JavaFile = {
    filePath: params.filePath,
    content: params.content,
    outline: params.outline
  }
  for (const lookup of request.lookups) {
    const found =
      lookup.kind === 'type'
        ? await openType(search, current, request.offset, lookup)
        : await lookUpName(search, current, request.offset, lookup)
    if (found) {
      return found
    }
  }
  return null
}
