import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, toNamespacedPath } from 'node:path'
import type * as HistoryFilesystem from '@orca/history-filesystem'
import { ORCAD_HISTORY_FILESYSTEM_FILENAME } from './orcad-artifacts'

export type { HistoryDirectory } from '@orca/history-filesystem'
const requireFromHere = createRequire(__filename)
let loaded: typeof HistoryFilesystem | undefined

/** Worker-only: no binary load or filesystem mutation on the launch path. */
export function loadHistoryFilesystem(): typeof HistoryFilesystem {
  if (loaded) {
    return loaded
  }
  const checkout =
    basename(__dirname) === 'chunks'
      ? join(__dirname, '..', '..', '..')
      : join(__dirname, '..', '..')
  const roots =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? [process.resourcesPath, checkout]
      : [checkout]
  const failures: string[] = []
  for (const candidate of [
    () => join(__dirname, ORCAD_HISTORY_FILESYSTEM_FILENAME),
    () => join(__dirname, '..', '..', ORCAD_HISTORY_FILESYSTEM_FILENAME),
    () => {
      const path = realpathSync(requireFromHere.resolve('@orca/history-filesystem'))
      if (
        !roots.some((root) => {
          const fromRoot = relative(realpathSync(root), path)
          return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
        })
      ) {
        throw new Error('History filesystem module is outside the app')
      }
      return path
    }
  ]) {
    try {
      // SAFETY: only the app's staged binary or validated workspace package is loaded.
      const binding: typeof HistoryFilesystem = requireFromHere(candidate())
      if (typeof binding.openDirectory !== 'function') {
        throw new Error('Invalid history filesystem module')
      }
      loaded = {
        openDirectory: (path, followRoot) =>
          binding.openDirectory(toNamespacedPath(path), followRoot)
      }
      return loaded
    } catch (error) {
      failures.push(String(error))
    }
  }
  throw new Error(`History filesystem build is unavailable: ${failures.join('; ')}`)
}
