export type ImportSpecifierHit = { specifier: string; startColumn: number; endColumn: number }

export type ModuleResolutionConfig = {
  configDir: string
  baseUrl?: string
  paths?: Record<string, readonly string[]>
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s*\*\s*from\s*)(['"])([^'"\n]+)\1/g

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json']

/** The quoted module specifier of an import/export/require covering `column` (1-based). */
export function findImportSpecifierAt(line: string, column: number): ImportSpecifierHit | null {
  for (const match of line.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[2]
    const endColumn = (match.index ?? 0) + match[0].length
    const startColumn = endColumn - specifier.length - 1
    if (column >= startColumn && column <= endColumn) {
      return { specifier, startColumn, endColumn }
    }
  }
  return null
}

function separatorOf(path: string): '/' | '\\' {
  return /^[A-Za-z]:\\/.test(path) || (!path.includes('/') && path.includes('\\')) ? '\\' : '/'
}

export function resolvePath(base: string, relative: string): string {
  const separator = separatorOf(base)
  const rooted = /^([A-Za-z]:)?[\\/]/.test(relative)
  const segments = (rooted ? relative : `${base}/${relative}`).split(/[\\/]+/)
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      if (resolved.length > 1) {
        resolved.pop()
      }
    } else if (segment !== '.' && (segment !== '' || resolved.length === 0)) {
      resolved.push(segment)
    }
  }
  return resolved.join(separator) || separator
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path.slice(0, index + 1) || '.' : path.slice(0, index)
}

function mappedBases(specifier: string, config: ModuleResolutionConfig): string[] {
  const root = config.baseUrl ? resolvePath(config.configDir, config.baseUrl) : config.configDir
  const bases: string[] = []
  for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
    const star = pattern.indexOf('*')
    let captured: string | null = null
    if (star === -1) {
      captured = pattern === specifier ? '' : null
    } else {
      const prefix = pattern.slice(0, star)
      const suffix = pattern.slice(star + 1)
      if (
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
      ) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length)
      }
    }
    if (captured !== null) {
      for (const target of targets) {
        bases.push(resolvePath(root, target.replace('*', captured)))
      }
    }
  }
  if (config.baseUrl) {
    bases.push(resolvePath(root, specifier))
  }
  return bases
}

/** Files a specifier may name, in TypeScript's lookup order; bare package names yield none. */
export function importCandidatePaths(
  specifier: string,
  sourceFilePath: string,
  config: ModuleResolutionConfig | null
): string[] {
  const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.'
  const bases = relative
    ? [resolvePath(dirnameOf(sourceFilePath), specifier)]
    : config
      ? mappedBases(specifier, config)
      : []
  return bases.flatMap((base) => {
    const separator = separatorOf(base)
    return [
      base,
      ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => `${base}${separator}index${extension}`)
    ]
  })
}

/** tsconfig/jsconfig `compilerOptions`, tolerating comments and trailing commas. */
export function parseModuleResolutionConfig(
  text: string,
  configDir: string
): ModuleResolutionConfig | null {
  const withoutComments = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, quoted: string | undefined) => quoted ?? ''
  )
  try {
    const parsed = JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1')) as {
      compilerOptions?: { baseUrl?: unknown; paths?: unknown }
    }
    const options = parsed.compilerOptions ?? {}
    return {
      configDir,
      ...(typeof options.baseUrl === 'string' ? { baseUrl: options.baseUrl } : {}),
      ...(options.paths && typeof options.paths === 'object'
        ? { paths: options.paths as Record<string, string[]> }
        : {})
    }
  } catch {
    return null
  }
}

/** Directories from the file's folder up to `rootPath`, nearest first. */
export function configSearchDirectories(sourceFilePath: string, rootPath: string): string[] {
  const directories: string[] = []
  let current = dirnameOf(sourceFilePath)
  const root = resolvePath(rootPath, '.')
  while (current.startsWith(root)) {
    directories.push(current)
    if (current === root) {
      break
    }
    const parent = dirnameOf(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return directories
}
