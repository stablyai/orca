import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeechEngine } from './speech-model-engine'
import transcribeCppPackages from './transcribe-cpp-packages.json'

/** Desktop and orca serve share the app’s speech engine packages; orcad slots omit them. */

/** Set by `orca serve` for orcad: the app's node_modules directory holding the speech engine packages. */
export const SPEECH_RECOGNIZER_DIR_ENV = 'ORCA_SPEECH_RECOGNIZER_DIR'

export function speechRecognizerPackageName(platform: string, arch: string): string {
  return platform === 'win32' && arch === 'x64'
    ? 'sherpa-onnx-win-x64'
    : `sherpa-onnx-${platform}-${arch}`
}

// Intel Macs stay on sherpa: transcribe-cpp's darwin-x64 build is SSE-only with no GPU. Packaging reads the same table.
const TRANSCRIBE_CPP_PACKAGES: Record<string, string> = transcribeCppPackages

/** Whether `nodeModulesDir` holds a loadable copy of `engine` for this host. */
export function hasSpeechEnginePackage(
  nodeModulesDir: string,
  engine: SpeechEngine,
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  if (engine === 'sherpa') {
    const sherpa = speechRecognizerPackageName(platform, arch)
    return existsSync(join(nodeModulesDir, sherpa, 'sherpa-onnx.node'))
  }
  const native = TRANSCRIBE_CPP_PACKAGES[`${platform}-${arch}`]
  return (
    native !== undefined &&
    existsSync(join(nodeModulesDir, 'transcribe-cpp', 'package.json')) &&
    existsSync(join(nodeModulesDir, ...native.split('/'), 'contract.json'))
  )
}
