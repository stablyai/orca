import { pluginFileBaseName, type PluginFileMatchResult } from './plugin-file-match'

/**
 * Files Orca opens itself, or that usually hold secrets or drive tooling. A plugin editor may be
 * offered for them in the view toggle, but never opens them by default.
 */
const CORE_FILE_TYPES = new Set([
  'json',
  'jsonc',
  'json5',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'md',
  'mdx',
  'markdown',
  'mmd',
  'mermaid',
  'yaml',
  'yml',
  'toml',
  'ini',
  'csv',
  'tsv',
  'ipynb',
  'html',
  'htm',
  'css',
  'txt',
  'lock',
  'env',
  'pem',
  'key',
  'p12',
  'pfx'
])

const CORE_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'tsconfig.json',
  '.npmrc',
  'kubeconfig'
])

/** Whether a plugin editor that matched this file may open it by default. */
export function customEditorMayOpenByDefault(
  filePath: string,
  match: PluginFileMatchResult
): boolean {
  const name = pluginFileBaseName(filePath)
  if (CORE_FILE_NAMES.has(name) || name === '.env' || name.startsWith('.env.')) {
    return false
  }
  return match.by === 'filename' || !CORE_FILE_TYPES.has(match.extension.slice(1))
}
