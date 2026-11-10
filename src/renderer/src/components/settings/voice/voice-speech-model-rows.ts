import type { SpeechModelManifest, SpeechModelState } from '../../../../../shared/speech-types'
import { isOfferedSpeechModel } from '../../../../../shared/speech-model-retirement'
import {
  speechModelQuality,
  type SpeechModelQuality
} from '../../../../../shared/speech-model-quality'

export type VoiceSpeechModelTab = 'local' | 'cloud'

export type VoiceSpeechModelRowData = {
  manifest: SpeechModelManifest
  state: SpeechModelState | undefined
  /** null for a retired model, which is only listed so its files can be deleted. */
  quality: SpeechModelQuality | null
}

export function speechModelTab(manifest: SpeechModelManifest): VoiceSpeechModelTab {
  return manifest.provider === 'local' ? 'local' : 'cloud'
}

/** A tab's rows: models for the language first, then ones that can't handle it, then retired downloads. */
export function voiceSpeechModelRows(
  catalog: readonly SpeechModelManifest[],
  modelStates: readonly SpeechModelState[],
  tab: VoiceSpeechModelTab,
  language: string
): VoiceSpeechModelRowData[] {
  const supported: VoiceSpeechModelRowData[] = []
  const unsupported: VoiceSpeechModelRowData[] = []
  const retired: VoiceSpeechModelRowData[] = []
  for (const manifest of catalog) {
    if (speechModelTab(manifest) !== tab) {
      continue
    }
    const state = modelStates.find((s) => s.id === manifest.id)
    if (!isOfferedSpeechModel(manifest)) {
      // Retired models stay listed only while their files are on disk.
      if (manifest.provider === 'local' && (state?.status === 'ready' || state?.needsUpdate)) {
        retired.push({ manifest, state, quality: null })
      }
      continue
    }
    const quality = speechModelQuality(manifest, language)
    ;(quality.kind === 'unsupported' ? unsupported : supported).push({ manifest, state, quality })
  }
  return [...supported, ...unsupported, ...retired]
}
