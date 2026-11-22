import { existsSync } from 'node:fs'
import { join } from 'node:path'
import transcribeCppPackages from './transcribe-cpp-packages.json'

/** Desktop and orca serve share the app’s speech engine packages; orcad slots omit them. */

/** Set by `orca serve` for orcad: the app's node_modules directory holding the speech engine packages. */
export const SPEECH_RECOGNIZER_DIR_ENV = 'ORCA_SPEECH_RECOGNIZER_DIR'

// Packaging reads the same table. Intel Macs run transcribe-cpp on the CPU (its x64 build has no GPU backend).
const TRANSCRIBE_CPP_PACKAGES: Record<string, string> = transcribeCppPackages

/** Whether `nodeModulesDir` holds transcribe-cpp and this host's native package for it. */
export function hasSpeechEnginePackage(
  nodeModulesDir: string,
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  const native = TRANSCRIBE_CPP_PACKAGES[`${platform}-${arch}`]
  return (
    native !== undefined &&
    existsSync(join(nodeModulesDir, 'transcribe-cpp', 'package.json')) &&
    existsSync(join(nodeModulesDir, ...native.split('/'), 'contract.json'))
  )
}
