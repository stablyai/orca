import { relativePathInsideRoot, resolveRuntimePath } from '../file-access/cross-platform-path'
import { findExportDeclaration, findStarReexports } from './export-declaration-scan'
import {
  aliasModulePaths,
  directoryOf,
  importFileCandidates,
  isRelativeSpecifier,
  parseCompilerConfig,
  type ImportAliasConfig
} from './import-path-candidates'
import type { ImportReference } from './import-reference-scan'

export type ImportDefinitionIo = {
  /** One answer per path, in order. */
  pathsExist: (paths: string[]) => Promise<boolean[]>
  /** `null` when the file cannot be read as text. */
  readText: (path: string) => Promise<string | null>
}

export type ImportDefinition = { filePath: string; line: number; column: number; content: string }

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']
// Barrel files rarely chain deeper; the cap also stops re-export cycles.
const MAX_REEXPORT_DEPTH = 5
const MAX_CONFIG_EXTENDS_DEPTH = 4
const MAX_CONFIG_SEARCH_DEPTH = 32

async function firstExisting(io: ImportDefinitionIo, candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) {
    return null
  }
  const exists = await io.pathsExist(candidates)
  const index = exists.findIndex(Boolean)
  return index === -1 ? null : candidates[index]
}

async function readAliasConfig(
  io: ImportDefinitionIo,
  isInside: (path: string) => boolean,
  configPath: string,
  depth: number
): Promise<ImportAliasConfig> {
  const text = isInside(configPath) ? await io.readText(configPath) : null
  const parsed = text === null ? null : parseCompilerConfig(text)
  if (!parsed) {
    return {}
  }
  const directory = directoryOf(configPath)
  let inherited: ImportAliasConfig = {}
  // Package-published bases are out of reach; only configs inside the project are followed.
  for (const base of depth < MAX_CONFIG_EXTENDS_DEPTH ? parsed.extends : []) {
    if (isRelativeSpecifier(base)) {
      const basePath = resolveRuntimePath(directory, base)
      const next = await readAliasConfig(
        io,
        isInside,
        /\.json$/i.test(basePath) ? basePath : `${basePath}.json`,
        depth + 1
      )
      // A later entry of an `extends` list overrides an earlier one, field by field.
      inherited = {
        baseDirectory: next.baseDirectory ?? inherited.baseDirectory,
        paths: next.paths ?? inherited.paths,
        pathsDirectory: next.paths ? next.pathsDirectory : inherited.pathsDirectory
      }
    }
  }
  return {
    baseDirectory:
      parsed.baseUrl === undefined
        ? inherited.baseDirectory
        : resolveRuntimePath(directory, parsed.baseUrl),
    paths: parsed.paths ?? inherited.paths,
    pathsDirectory: parsed.paths ? directory : inherited.pathsDirectory
  }
}

/** Aliases of the nearest tsconfig/jsconfig at or above `fromFilePath`, never above the project root. */
async function nearestAliasConfig(
  io: ImportDefinitionIo,
  isInside: (path: string) => boolean,
  fromFilePath: string
): Promise<ImportAliasConfig> {
  const configPaths: string[] = []
  let directory = directoryOf(fromFilePath)
  for (let depth = 0; depth < MAX_CONFIG_SEARCH_DEPTH && isInside(directory); depth++) {
    configPaths.push(...CONFIG_NAMES.map((name) => resolveRuntimePath(directory, name)))
    const parent = directoryOf(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  // Why only the nearest: TypeScript never merges an ancestor config unless `extends` names it.
  const nearest = await firstExisting(io, configPaths)
  return nearest ? readAliasConfig(io, isInside, nearest, 0) : {}
}

function positionAt(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length, column: offset - lineStart + 1 }
}

export function createImportDefinitionResolver(args: {
  io: ImportDefinitionIo
  /** Navigation never leaves this directory, so a target is always a file of the same project. */
  rootPath: string
}): (reference: ImportReference, fromFilePath: string) => Promise<ImportDefinition | null> {
  const { io, rootPath } = args
  const isInside = (path: string): boolean => relativePathInsideRoot(rootPath, path) !== null
  const aliasConfigs = new Map<string, Promise<ImportAliasConfig>>()

  const resolveModuleFile = async (
    specifier: string,
    fromFilePath: string
  ): Promise<string | null> => {
    let modulePaths: string[]
    if (isRelativeSpecifier(specifier)) {
      modulePaths = [resolveRuntimePath(directoryOf(fromFilePath), specifier)]
    } else {
      const directory = directoryOf(fromFilePath)
      let config = aliasConfigs.get(directory)
      if (!config) {
        config = nearestAliasConfig(io, isInside, fromFilePath)
        aliasConfigs.set(directory, config)
      }
      modulePaths = aliasModulePaths(specifier, await config)
    }
    return firstExisting(io, modulePaths.flatMap(importFileCandidates).filter(isInside))
  }

  const locate = async (
    reference: ImportReference,
    fromFilePath: string,
    depth: number,
    required: boolean
  ): Promise<ImportDefinition | null> => {
    const filePath = await resolveModuleFile(reference.specifier, fromFilePath)
    const content = filePath === null ? null : await io.readText(filePath)
    if (filePath === null || content === null) {
      return null
    }
    const top: ImportDefinition = { filePath, line: 1, column: 1, content }
    if (reference.exportName === '*') {
      return top
    }
    const declaration = findExportDeclaration(content, reference.exportName)
    if (declaration?.kind === 'declaration') {
      return { filePath, content, ...positionAt(content, declaration.offset) }
    }
    if (depth < MAX_REEXPORT_DEPTH) {
      if (declaration?.kind === 'reexport') {
        const followed = await locate(declaration, filePath, depth + 1, false)
        return followed ?? top
      }
      for (const specifier of findStarReexports(content)) {
        const followed = await locate(
          { specifier, exportName: reference.exportName },
          filePath,
          depth + 1,
          true
        )
        if (followed) {
          return followed
        }
      }
    }
    // A star re-export only counts when it actually declares the name; otherwise open the module itself.
    return required ? null : top
  }

  return (reference, fromFilePath) =>
    isInside(fromFilePath) ? locate(reference, fromFilePath, 0, false) : Promise.resolve(null)
}
