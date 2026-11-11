import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import {
  findSpeechModelUpdateTarget,
  isSpeechModelReady,
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

// Only a model seen ready stays so: legacy or retired files never come back, so later presses skip the check.
const readyModelIds = new Set<string>()
// What the pill offered stays offered until the model is ready, so a cancelled or failed download can resume.
const offeredTargets = new Map<string, SpeechModelUpdateTarget>()
// A press during a prefetch joins it instead of asking main again.
const inFlightChecks = new Map<string, Promise<SpeechModelUpdateTarget | null>>()

type CheckedVoice = Pick<VoiceSettings, 'enabled' | 'sttModel'>

/** True when no check is needed before recording with this model. */
export function isSpeechModelKnownReady(voice: CheckedVoice): boolean {
  return !voice.enabled || readyModelIds.has(voice.sttModel) || isPairedWebClientWindow()
}

/** The download the selected model needs before it can dictate, checked before any mic capture. */
export function checkSpeechModelUpdate(
  voice: CheckedVoice
): Promise<SpeechModelUpdateTarget | null> {
  // Why skip paired web clients: the models live on the host, whose own window shows this.
  if (isSpeechModelKnownReady(voice)) {
    return Promise.resolve(null)
  }
  const modelId = voice.sttModel
  let check = inFlightChecks.get(modelId)
  if (!check) {
    check = runCheck(voice).finally(() => inFlightChecks.delete(modelId))
    inFlightChecks.set(modelId, check)
  }
  return check
}

async function runCheck(voice: CheckedVoice): Promise<SpeechModelUpdateTarget | null> {
  try {
    const [catalog, states] = await Promise.all([
      loadSpeechCatalog(),
      window.api.speech.getModelStates()
    ])
    useAppStore.getState().setModelStates(states)
    const selected = states.find((state) => state.id === voice.sttModel)
    if (isSpeechModelReady(selected)) {
      readyModelIds.add(voice.sttModel)
      offeredTargets.delete(voice.sttModel)
      return null
    }
    const target =
      findSpeechModelUpdateTarget(voice, catalog, states) ??
      offeredTargets.get(voice.sttModel) ??
      null
    if (target) {
      offeredTargets.set(voice.sttModel, target)
    }
    return target
  } catch {
    // A failed check never blocks dictation; the start path reports a model that can't load.
    return null
  }
}

export function resetSpeechModelUpdateCheckForTests(): void {
  catalogRequest = null
  readyModelIds.clear()
  offeredTargets.clear()
  inFlightChecks.clear()
}
