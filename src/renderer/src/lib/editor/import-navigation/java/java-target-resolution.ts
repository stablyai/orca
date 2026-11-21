import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { resolveModulePath } from '../import-module-candidates'
import type { ImportNavigationFileAccess } from '../import-navigation-file-access'
import type { ImportNavigationTarget } from '../import-target-resolution'
import { locateJavaMember, locateJavaType } from './java-declaration-locate'
import type { JavaNavigationRequest } from './java-navigation-request'
import {
  javaTypeCandidates,
  outlineJavaSource,
  type JavaSourceOutline
} from './java-source-outline'

type JavaFile = { filePath: string; content: string; outline: JavaSourceOutline }

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

/** The file declaring the top-level type of `qualifiedName`, plus the nested type names after it. */
async function resolveTypeFile(
  search: JavaSearch,
  fromFile: JavaFile,
  qualifiedName: string
): Promise<{ file: JavaFile; nested: string[] } | null> {
  const segments = qualifiedName.split('.')
  const typeIndex = Math.max(
    0,
    segments.findIndex((segment) => /^[A-Z]/.test(segment))
  )
  const fileName = `${segments[typeIndex]}.java`
  const relativePath = [...segments.slice(0, typeIndex), fileName].join('/')
  const nested = segments.slice(typeIndex + 1)
  const candidates = sourceRoots(fromFile)
    .map((root) => resolveModulePath(root, relativePath))
    .filter((candidate) => getRelativePathInsideRoot(candidate, search.rootPath) !== null)
  const exists = candidates.length > 0 ? await search.access.pathsExist(candidates) : []
  for (const [index, candidate] of candidates.entries()) {
    const file = exists[index] ? await readJavaFile(search, candidate) : null
    if (file) {
      return { file, nested }
    }
  }
  // Why: another module (e.g. Gradle's core/src/main/java) holds the type; find it by name.
  const named = (await search.access.findFilesNamed?.(fileName)) ?? []
  const matches = named
    .filter((path) => forwardSlashes(path).endsWith(`/${relativePath}`))
    .sort(
      (a, b) => sharedPrefixLength(b, fromFile.filePath) - sharedPrefixLength(a, fromFile.filePath)
    )
  for (const match of matches.slice(0, 3)) {
    const file = await readJavaFile(search, match)
    if (file) {
      return { file, nested }
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
  member: string,
  skipOwn: boolean,
  depth: number
): Promise<ImportNavigationTarget | null> {
  if (search.visited.has(file.filePath)) {
    return null
  }
  search.visited.add(file.filePath)
  const own = skipOwn ? null : locateJavaMember(file.content, member)
  if (own !== null) {
    return target(file, own)
  }
  if (depth >= MAX_SUPERTYPE_DEPTH) {
    return null
  }
  for (const supertype of file.outline.supertypes) {
    for (const qualifiedName of javaTypeCandidates(file.outline, supertype)) {
      const resolved = await resolveTypeFile(search, file, qualifiedName)
      if (resolved) {
        const found = await memberInHierarchy(search, resolved.file, member, false, depth + 1)
        if (found) {
          return found
        }
        break
      }
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
  for (const qualifiedName of request.types) {
    const resolved = await resolveTypeFile(search, current, qualifiedName)
    if (!resolved) {
      continue
    }
    const { file, nested } = resolved
    const typeName =
      nested.at(-1) ?? qualifiedName.split('.').find((segment) => /^[A-Z]/.test(segment))
    const typeOffset = typeName ? locateJavaType(file.content, typeName) : null
    if (!request.member) {
      return target(file, typeOffset)
    }
    return (
      (await memberInHierarchy(search, file, request.member, false, 0)) ?? target(file, typeOffset)
    )
  }
  if (!request.member || !request.searchHierarchy) {
    return null
  }
  if (!request.skipCurrentFile) {
    const own = locateJavaMember(current.content, request.member)
    if (own !== null) {
      return target(current, own)
    }
  }
  // Why: inherited members shadow names brought in with `import static …*`.
  const inherited = await memberInHierarchy(search, current, request.member, true, 0)
  if (inherited) {
    return inherited
  }
  for (const staticType of request.staticTypes) {
    const resolved = await resolveTypeFile(search, current, staticType)
    const offset = resolved ? locateJavaMember(resolved.file.content, request.member) : null
    if (resolved && offset !== null) {
      return target(resolved.file, offset)
    }
  }
  return null
}
