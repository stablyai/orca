import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { locateExportedName, starExportSpecifiers } from './export-declaration-locate'
import {
  isRelativeModuleSpecifier,
  mappedModulePaths,
  moduleFileCandidates,
  resolveModulePath
} from './import-module-candidates'
import type { ImportNavigationFileAccess } from './import-navigation-file-access'
import type { ImportNavigationRequest } from './import-statement-scan'
import { loadImportPathMappings } from './tsconfig-import-paths'

export type ImportNavigationTarget = {
  filePath: string
  content: string
  /** Offset of the exported declaration, or 0 for the module itself. */
  offset: number
}

type ModuleFile = { filePath: string; content: string }

type ExportSearch = { remainingLookups: number; visited: Set<string> }

// Bounds barrel chains so a cyclic, huge or broken re-export graph cannot stall a click.
const MAX_MODULE_LOOKUPS = 24

async function resolveModuleFile(
  access: ImportNavigationFileAccess,
  fromFilePath: string,
  rootPath: string,
  rawSpecifier: string
): Promise<ModuleFile | null> {
  // Why: bundler suffixes such as `?raw` or `?worker` name the same file; a leading `#` is an alias.
  const specifier = rawSpecifier.replace(/(?!^)[?#].*$/, '')
  const modulePaths = isRelativeModuleSpecifier(specifier)
    ? [resolveModulePath(dirname(fromFilePath), specifier)]
    : mappedModulePaths(specifier, await loadImportPathMappings(access, fromFilePath, rootPath))
  const candidates = [...new Set(modulePaths.flatMap(moduleFileCandidates))].filter(
    (candidate) => getRelativePathInsideRoot(candidate, rootPath) !== null
  )
  if (candidates.length === 0) {
    return null
  }
  const exists = await access.pathsExist(candidates)
  for (const [index, candidate] of candidates.entries()) {
    if (!exists[index]) {
      continue
    }
    // Why: a directory also exists; only a readable text file can be opened.
    const content = await access.readText(candidate)
    if (content !== null) {
      return { filePath: candidate, content }
    }
  }
  return null
}

function resolveReexportTarget(
  access: ImportNavigationFileAccess,
  rootPath: string,
  module: ModuleFile,
  specifier: string,
  search: ExportSearch
): Promise<ModuleFile | null> {
  // Why: every lookup is a host round trip, so a missing barrel target spends the budget too.
  if (search.remainingLookups <= 0) {
    return Promise.resolve(null)
  }
  search.remainingLookups -= 1
  return resolveModuleFile(access, module.filePath, rootPath, specifier)
}

async function followExport(
  access: ImportNavigationFileAccess,
  rootPath: string,
  module: ModuleFile,
  name: string,
  search: ExportSearch
): Promise<ImportNavigationTarget | null> {
  const key = `${module.filePath}\0${name}`
  if (search.visited.has(key)) {
    return null
  }
  search.visited.add(key)
  const location = locateExportedName(module.content, name)
  if (location?.kind === 'declaration') {
    return { ...module, offset: location.offset }
  }
  if (location?.kind === 'reexport') {
    const next = await resolveReexportTarget(access, rootPath, module, location.specifier, search)
    if (!next) {
      return null
    }
    return location.name === '*'
      ? { ...next, offset: 0 }
      : followExport(access, rootPath, next, location.name, search)
  }
  for (const specifier of starExportSpecifiers(module.content)) {
    const next = await resolveReexportTarget(access, rootPath, module, specifier, search)
    const found = next ? await followExport(access, rootPath, next, name, search) : null
    if (found) {
      return found
    }
  }
  return null
}

/** The file an import resolves to inside `rootPath`, positioned on the imported declaration when found. */
export async function resolveImportNavigationTarget(
  access: ImportNavigationFileAccess,
  params: ImportNavigationRequest & { fromFilePath: string; rootPath: string }
): Promise<ImportNavigationTarget | null> {
  const module = await resolveModuleFile(
    access,
    params.fromFilePath,
    params.rootPath,
    params.specifier
  )
  if (!module) {
    return null
  }
  if (params.importedName === null || params.importedName === '*') {
    return { ...module, offset: 0 }
  }
  const found = await followExport(access, params.rootPath, module, params.importedName, {
    remainingLookups: MAX_MODULE_LOOKUPS,
    visited: new Set()
  })
  // Why: an export the scanner cannot see still opens the module the import names.
  return found ?? { ...module, offset: 0 }
}
