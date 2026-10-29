import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_CLIENT_FILES_FILENAME } from './bundled-web-client-manifest'

export const WEB_CLIENT_INDEX_FILENAME = 'web-index.html'

/** Share paired-browser bundle lookup between Electron --serve and the CLI supplying orcad’s root. */
export function findBundledWebClientRoot(appPath: string): string | undefined {
  const roots = [
    join(appPath, 'out', 'web'),
    // Unpacked electron-vite sets appPath to out/main beside the web bundle.
    join(appPath, '..', 'web')
  ]
  const standalone = roots.find((root) => existsSync(join(root, WEB_CLIENT_INDEX_FILENAME)))
  if (standalone) {
    return standalone
  }
  const sharedAppPath = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
  const sharedRoots = [
    join(sharedAppPath, 'out', 'renderer'),
    join(sharedAppPath, '..', 'renderer')
  ]
  return sharedRoots.find(
    (root) =>
      existsSync(join(root, WEB_CLIENT_INDEX_FILENAME)) &&
      existsSync(join(root, WEB_CLIENT_FILES_FILENAME))
  )
}
