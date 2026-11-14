import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeRelayOmpStatusExtension(homeDir: string, source: string): string | null {
  const directory = join(homeDir, '.orca-relay', 'omp-managed-status-extension')
  try {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'orca-agent-status.ts')
    try {
      if (!readFileSync(path, 'utf8').includes('@orca-managed-pi-extension')) {
        return null
      }
    } catch {
      // A missing file is safe to create.
    }
    writeFileSync(path, source)
    return path
  } catch (err) {
    process.stderr.write(
      `[plugin-overlay] failed to write OMP managed status extension: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return null
  }
}
