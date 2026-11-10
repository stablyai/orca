import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import {
  findSpeechModelUpdateTarget,
  type SpeechModelUpdateTarget
} from './speech-model-update-target'

// The catalog never changes while the app runs.
let catalogRequest: Promise<SpeechModelManifest[]> | null = null

export function loadSpeechCatalog(): Promise<SpeechModelManifest[]> {
  catalogRequest ??= Promise.resolve()
    // The paired web client's fallback resolves with nothing rather than a list.
    .then(async () => (await window.api.speech.getCatalog()) ?? [])
    .catch(() => {
      // Not cached, so the next press asks again.
      catalogRequest = null
      return []
    })
  return catalogRequest
}

// A model found up to date stays so: legacy or retired files never come back, so later presses skip the check.
const upToDateModelIds = new Set<string>()

/** The download the selected model needs before it can dictate, checked before any mic capture. */
export async function checkSpeechModelUpdate(
  voice: Pick<VoiceSettings, 'enabled' | 'sttModel'>
): Promise<SpeechModelUpdateTarget | null> {
  // Why skip paired web clients: the models live on the host, whose own window shows this.
  if (!voice.enabled || upToDateModelIds.has(voice.sttModel) || isPairedWebClientWindow()) {
    return null
  }
  try {
    const [catalog, states] = await Promise.all([
      loadSpeechCatalog(),
      window.api.speech.getModelStates()
    ])
    useAppStore.getState().setModelStates(states)
    const target = findSpeechModelUpdateTarget(voice, catalog, states)
    // An empty catalog proves nothing, so it isn't remembered as up to date.
    if (!target && catalog.length > 0) {
      upToDateModelIds.add(voice.sttModel)
    }
    return target
  } catch {
    // A failed check never blocks dictation; the start path reports a model that can't load.
    return null
  }
}

export function resetSpeechModelUpdateCheckForTests(): void {
  catalogRequest = null
  upToDateModelIds.clear()
}
