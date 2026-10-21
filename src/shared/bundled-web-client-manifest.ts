import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const WEB_CLIENT_FILES_FILENAME = '.orca-web-client-files.json'

/** Limits HTTP access when desktop and browser assets share one installed directory. */
export function readBundledWebClientFiles(root: string): ReadonlySet<string> | undefined {
  const manifestPath = join(root, WEB_CLIENT_FILES_FILENAME)
  if (!existsSync(manifestPath)) {
    return undefined
  }
  const files: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    !Array.isArray(files) ||
    !files.every(
      (file): file is string =>
        typeof file === 'string' &&
        (file === 'web-index.html' || /^(?:assets|cmaps|standard_fonts|wasm)\//.test(file)) &&
        !file.includes('\\') &&
        !file.includes('\0') &&
        file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
        !file.endsWith('.map')
    ) ||
    !files.includes('web-index.html')
  ) {
    throw new Error('Invalid bundled web client file manifest')
  }
  return new Set(files)
}
