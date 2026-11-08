import type { SpeechModelManifest } from './speech-types'

export function isOfferedSpeechModel(manifest: SpeechModelManifest): boolean {
  return manifest.replacedBy === undefined
}
