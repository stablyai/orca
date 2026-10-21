import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorEntry } from '../main/pty/overlay-mirror'

export function mirrorOpenCodeConfig(
  sourceDir: string,
  overlayDir: string,
  excludedPluginEntries: ReadonlySet<string>
): void {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    if (entry.name === 'plugins') {
      const isSymlink = entry.isSymbolicLink()
      let isLinkPointingToDir = false
      if (isSymlink) {
        try {
          isLinkPointingToDir = statSync(sourcePath).isDirectory()
        } catch {
          isLinkPointingToDir = false
        }
      }
      if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
        const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
        const overlayPluginsDir = join(overlayDir, 'plugins')
        mkdirSync(overlayPluginsDir, { recursive: true })
        for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
          if (excludedPluginEntries.has(pluginEntry.name)) {
            continue
          }
          mirrorEntry(
            join(resolvedSource, pluginEntry.name),
            join(overlayPluginsDir, pluginEntry.name)
          )
        }
        continue
      }
    }
    mirrorEntry(sourcePath, join(overlayDir, entry.name))
  }
}
