import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const WEB_CLIENT_INDEX_FILENAME = 'web-index.html'

/**
 * The browser client a paired server serves, found beside an app root. Shared so Electron
 * `--serve` and the CLI handing orcad its root look in the same places.
 */
export function findBundledWebClientRoot(appPath: string): string | undefined {
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, WEB_CLIENT_INDEX_FILENAME)))
}
