/**
 * The on-device speech recognizer (sherpa-onnx's N-API addon) by platform. Shared by the desktop's
 * worker paths and `orca serve`, which hands orcad the copy the installed app ships, because orcad
 * slots do not carry the ~70 MB recognizer themselves.
 */

/** Set by `orca serve` for orcad: the directory of the app's recognizer package. */
export const SPEECH_RECOGNIZER_DIR_ENV = 'ORCA_SPEECH_RECOGNIZER_DIR'

export function speechRecognizerPackageName(platform: string, arch: string): string {
  return platform === 'win32' && arch === 'x64'
    ? 'sherpa-onnx-win-x64'
    : `sherpa-onnx-${platform}-${arch}`
}
