// Picker for the Kokoro voice the mesh speaks replies in — desktop parity with
// `mobile/src/voice/MeshVoicePicker.tsx`. The two pickers deliberately share
// the same schema (`KokoroVoice`, same describe logic, same fallback list, same
// preview line) so a desktop and a mobile user see the same rows.
//
// Why a dedicated section rather than reusing VoiceSpeechModelSection: that one
// is the STT half of the pipeline (mic → transcript). This is the OUTPUT half
// (mesh TTS). Mixing them would have hidden that split — see HANDOFF.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, Volume2 } from 'lucide-react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { translate } from '@/i18n/i18n'
import { DesktopMeshSpeaker } from '../../lib/voice/desktop-mesh-speech'
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICE_STORAGE_KEY } from '../../lib/voice/mesh-speech-config'
import {
  fetchKokoroVoices,
  voicePreviewText,
  type KokoroVoice
} from '../../lib/voice/desktop-kokoro-voices'

type KokoroVoicePickerSectionProps = {
  voiceSettings: VoiceSettings
  hostEndpoint?: string | null
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function KokoroVoicePickerSection({
  voiceSettings,
  hostEndpoint,
  onUpdateVoiceSettings
}: KokoroVoicePickerSectionProps): React.JSX.Element {
  const [voices, setVoices] = useState<KokoroVoice[] | null>(null)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const speakerRef = useRef<DesktopMeshSpeaker | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      const list = await fetchKokoroVoices(hostEndpoint ?? null, controller.signal)
      if (!cancelled) {
        setVoices(list)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [hostEndpoint])

  useEffect(
    () => () => {
      speakerRef.current?.stop()
      speakerRef.current = null
    },
    []
  )

  const choose = useCallback(
    async (voice: KokoroVoice): Promise<void> => {
      // Why mirror the storage-key constant in the log line: a future maintainer
      // digging through persisted preferences needs the literal name to find the
      // mobile-side counterpart. See KOKORO_VOICE_STORAGE_KEY in mesh-speech-config.
      console.debug(`[voice] persist ${KOKORO_VOICE_STORAGE_KEY}=${voice.id}`)
      onUpdateVoiceSettings({ kokoroVoice: voice.id })
      if (!speakerRef.current) {
        speakerRef.current = new DesktopMeshSpeaker()
      }
      const speaker = speakerRef.current
      speaker.setHostEndpoint(hostEndpoint)
      setPreviewingId(voice.id)
      try {
        await speaker.speak(voicePreviewText(voice), { voice: voice.id })
      } catch {
        // Why swallow: a preview failure (mesh offline, speaker muted) is not
        // worth a toast on a settings screen. The persisted choice still
        // applies, and the next agent reply will retry through the same path.
      } finally {
        setPreviewingId((current) => (current === voice.id ? null : current))
      }
    },
    [hostEndpoint, onUpdateVoiceSettings]
  )

  // Group by language so 67 voices read as a short list of familiar sections
  // rather than one undifferentiated wall of ids. Matches the mobile picker.
  const grouped = useMemo(() => {
    const map = new Map<string, KokoroVoice[]>()
    for (const voice of voices ?? []) {
      const bucket = map.get(voice.language) ?? []
      bucket.push(voice)
      map.set(voice.language, bucket)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [voices])

  // Why default if absent: an older persisted profile may have a missing
  // kokoroVoice before this field shipped; match the same fallback the
  // getDefaultVoiceSettings hydration uses.
  const selectedId = voiceSettings.kokoroVoice || DEFAULT_KOKORO_VOICE

  return (
    <>
      <div className="space-y-1 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>
              {translate('auto.components.settings.VoicePane.9d2b14a47c', 'Mesh Voice')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.VoicePane.5b8a0e29d1',
                'Voice the mesh speaks replies in. Tap a row to hear it.'
              )}
            </p>
          </div>
        </div>
        {voices === null ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {translate('auto.components.settings.VoicePane.0e1c7a5b3d', 'Loading voices…')}
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {grouped.map(([language, entries]) => (
              <div key={language}>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {language}
                </p>
                <ul className="space-y-1" role="radiogroup" aria-label={language}>
                  {entries.map((voice) => {
                    const active = voice.id === selectedId
                    const isPreviewing = previewingId === voice.id
                    return (
                      <li key={voice.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={`${voice.label}, ${voice.gender}, ${language}`}
                          onClick={() => void choose(voice)}
                          className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                            active
                              ? 'border-muted-foreground/40 bg-accent font-medium text-accent-foreground'
                              : 'border-border bg-background/50 text-muted-foreground hover:border-muted-foreground/35 hover:text-foreground'
                          }`}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            {active ? (
                              <Check className="size-3.5" strokeWidth={2.4} />
                            ) : isPreviewing ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Volume2 className="size-3.5" strokeWidth={2} />
                            )}
                          </span>
                          <span className="flex-1 truncate">{voice.label}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground/80">
                            {voice.gender === 'unknown' ? voice.id : voice.gender}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
      <Separator />
    </>
  )
}
