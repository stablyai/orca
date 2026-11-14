/** Source files Orca transpiles to JavaScript when a plugin frame loads them, so plugins ship
 *  TypeScript and JSX with no build step. */
export const PLUGIN_SOURCE_MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.jsx'] as const

export function isPluginSourceModulePath(path: string): boolean {
  const lower = path.toLowerCase()
  return PLUGIN_SOURCE_MODULE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** Source files a worker's `main` (and its imports) may be; workers get no JSX. */
export function isPluginWorkerSourcePath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.ts') || lower.endsWith('.mts')
}
