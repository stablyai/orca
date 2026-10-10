import { CLOUD_SPEECH_PROVIDERS } from '../../../../shared/cloud-speech-providers'
import type { SpeechModelManifest, SpeechModelProvider } from '../../../../shared/speech-types'

export type SpeechModelGroup = {
  provider: SpeechModelProvider
  models: SpeechModelManifest[]
}

const PROVIDER_ORDER: readonly SpeechModelProvider[] = [
  'local',
  ...CLOUD_SPEECH_PROVIDERS.map((provider) => provider.id)
]

/** Groups catalog models by provider: on-device first, then the shared cloud provider order. */
export function groupSpeechModelsByProvider(catalog: SpeechModelManifest[]): SpeechModelGroup[] {
  const byProvider = new Map<SpeechModelProvider, SpeechModelManifest[]>()
  for (const manifest of catalog) {
    const models = byProvider.get(manifest.provider) ?? []
    models.push(manifest)
    byProvider.set(manifest.provider, models)
  }
  const rank = (provider: SpeechModelProvider): number => {
    const index = PROVIDER_ORDER.indexOf(provider)
    // Why: a provider a newer main process knows about still renders, after the known ones.
    return index === -1 ? PROVIDER_ORDER.length : index
  }
  return [...byProvider.entries()]
    .map(([provider, models]) => ({ provider, models }))
    .sort((a, b) => rank(a.provider) - rank(b.provider))
}
