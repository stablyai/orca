import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'

export type PackageManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Bare specifier (package or package subpath) to the names release source imports from it. */
export type PackageImports = Map<string, Set<string>>

// Anchored to a line start, with only import-clause characters, so prose in comments never matches.
// Type-only imports are erased and never load, so they need no stand-in.
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(?!type\s)([\w$*{},\s]*?)\s*\bfrom\s*(['"])([^'"\s]+)\2/gm
const BARE_IMPORT = /(?:^\s*import\s*|(?<![.\w$])import\s*\(\s*)(['"])([^'"\s]+)\1/gm
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@/-]*)?$/i
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/

function isPackageSpecifier(specifier: string): boolean {
  return PACKAGE_SPECIFIER.test(specifier) && !isBuiltin(specifier)
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function importedNames(clause: string): string[] {
  const names: string[] = []
  const outside = clause
    .replace(/\{[^}]*\}/, '')
    .trim()
    .replace(/,$/, '')
    .trim()
  if (outside && !outside.startsWith('*')) {
    names.push('default')
  }
  for (const part of clause.match(/\{([^}]*)\}/)?.[1]?.split(',') ?? []) {
    const name = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
      ?.trim()
    if (name && EXPORT_NAME.test(name)) {
      names.push(name)
    }
  }
  return names
}

/** Record what one release source file imports from packages. */
export function collectPackageImports(source: string, imports: PackageImports): void {
  for (const [, , specifier] of source.matchAll(BARE_IMPORT)) {
    if (isPackageSpecifier(specifier!) && !imports.has(specifier!)) {
      imports.set(specifier!, new Set())
    }
  }
  for (const [, clause, , specifier] of source.matchAll(STATIC_IMPORT)) {
    if (!isPackageSpecifier(specifier!)) {
      continue
    }
    const names = imports.get(specifier!) ?? new Set()
    for (const name of importedNames(clause!)) {
      names.add(name)
    }
    imports.set(specifier!, names)
  }
}

/** Node's package lookup: the nearest `node_modules/<name>` walking up from `root`. */
function resolvesFrom(root: string, name: string): boolean {
  for (let directory = root; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules', name, 'package.json'))) {
      return true
    }
    if (dirname(directory) === directory) {
      return false
    }
  }
}

function declaredPackages(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])
}

function standInModule(release: string, specifier: string, names: Set<string>): string {
  const reason =
    `Cross-version harness: release ${release} imports '${specifier}', which the current ` +
    'tree does not install, so this release code path cannot run here.'
  const lines = [
    `const reason = ${JSON.stringify(reason)}`,
    'function unavailable(name) {',
    "  const refuse = () => { throw new Error(`${reason} (used '${name}')`) }",
    '  return new Proxy(function unavailableExport() {}, {',
    // Why: module interop probes these at import time; any real use still refuses.
    "    get: (_target, key) => typeof key === 'symbol' || key === '__esModule' || key === 'then' ? undefined : refuse(),",
    '    apply: refuse,',
    '    construct: refuse',
    '  })',
    '}'
  ]
  for (const name of [...names].sort()) {
    lines.push(
      name === 'default'
        ? "export default unavailable('default')"
        : `export const ${name} = unavailable(${JSON.stringify(name)})`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Why: release source runs against the current install, and the release's RPC dispatcher
 * imports its whole method table, so one package the current tree no longer has fails every
 * wire suite at import time. Each package that does not resolve from the checkout and that
 * the current tree does not declare gets a stand-in in the checkout's own `node_modules`:
 * it loads, but any use throws naming the package, so a wire path that needs it still fails.
 * A package the current tree declares but cannot resolve is a broken install; it stays loud.
 */
export async function installMissingPackageStandIns(
  root: string,
  release: string,
  imports: PackageImports,
  currentManifest: PackageManifest
): Promise<string[]> {
  const declared = declaredPackages(currentManifest)
  const byPackage = new Map<string, string[]>()
  for (const specifier of imports.keys()) {
    const name = packageNameOf(specifier)
    if (declared.has(name)) {
      continue
    }
    const specifiers = byPackage.get(name)
    if (specifiers) {
      specifiers.push(specifier)
    } else if (!resolvesFrom(root, name)) {
      byPackage.set(name, [specifier])
    }
  }
  for (const [name, specifiers] of byPackage) {
    const directory = join(root, 'node_modules', ...name.split('/'))
    await mkdir(directory, { recursive: true })
    const exportsMap: Record<string, string> = {}
    for (const [index, specifier] of specifiers.sort().entries()) {
      const file = `stand-in-${index}.js`
      exportsMap[`.${specifier.slice(name.length)}`] = `./${file}`
      await writeFile(
        join(directory, file),
        standInModule(release, specifier, imports.get(specifier) ?? new Set())
      )
    }
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ name, version: '0.0.0-cross-version-stand-in', type: 'module', exports: exportsMap }, null, 2)}\n`
    )
  }
  return [...byPackage.keys()].sort()
}
