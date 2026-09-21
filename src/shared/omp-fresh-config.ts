import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OMP_FRESH_CONFIG_FILENAME, OMP_FRESH_CONFIG_SOURCE } from './omp-fresh-launch'

/** An empty path fails the launch guard without preventing unrelated terminal launches. */
export function materializeOmpFreshConfig(directory: string): string {
  try {
    const configPath = join(directory, OMP_FRESH_CONFIG_FILENAME)
    if (existsSync(configPath) && readFileSync(configPath, 'utf8') === OMP_FRESH_CONFIG_SOURCE) {
      return configPath
    }
    mkdirSync(directory, { recursive: true })
    writeFileSync(configPath, OMP_FRESH_CONFIG_SOURCE)
    return configPath
  } catch {
    return ''
  }
}
