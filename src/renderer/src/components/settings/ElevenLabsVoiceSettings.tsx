import { useEffect, useId, useRef, useState } from 'react'
import type { ElevenLabsVoice, VoiceSettings } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { playElevenLabsSpeech } from '../dictation/elevenlabs-playback'
import { translate } from '@/i18n/i18n'

type Props = {
  settings: VoiceSettings
  onUpdate: (updates: Partial<VoiceSettings>) => void
  refreshModelStates: () => void
  configureRequest: number
}

export function ElevenLabsVoiceSettings({
  settings,
  onUpdate,
  refreshModelStates,
  configureRequest
}: Props): React.JSX.Element {
  const id = useId()
  const keyInput = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')
  const cancelPreview = useRef<(() => void) | null>(null)
  const mounted = useRef(false)
  const configured = settings.elevenLabsApiKeyConfigured === true
  const voiceId = settings.elevenLabsVoiceId ?? ''
  const modelId = settings.elevenLabsTtsModel ?? 'eleven_flash_v2_5'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelPreview.current?.()
    }
  }, [])

  useEffect(() => {
    let canceled = false
    void window.api.speech
      .getElevenLabsApiKeyStatus?.()
      .then((status) => {
        if (!canceled && status.configured !== configured) {
          onUpdate({ elevenLabsApiKeyConfigured: status.configured })
          refreshModelStates()
        }
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [configured, onUpdate, refreshModelStates])

  useEffect(() => {
    if (configureRequest > 0) {
      keyInput.current?.focus()
    }
  }, [configureRequest])

  useEffect(() => {
    cancelPreview.current?.()
    cancelPreview.current = null
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Reflect the canceled audio request when its voice or provider changes.
    setPreviewing(false)
  }, [voiceId, modelId, configured, settings.ttsProvider])

  async function save(clear = false): Promise<void> {
    if (pending || loading) {
      return
    }
    setPending(true)
    setError('')
    cancelPreview.current?.()
    setPreviewing(false)
    try {
      await (clear
        ? window.api.speech.clearElevenLabsApiKey()
        : window.api.speech.saveElevenLabsApiKey(draft))
      if (!mounted.current) {
        return
      }
      setDraft('')
      setVoices([])
      onUpdate({ elevenLabsApiKeyConfigured: !clear })
      refreshModelStates()
    } catch {
      if (mounted.current) {
        setError(
          translate(
            'elevenLabsVoice.keyError',
            'Could not update the key. Stop dictation and check that encrypted storage is available.'
          )
        )
      }
    } finally {
      if (mounted.current) {
        setPending(false)
      }
    }
  }

  async function loadVoices(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.speech.listElevenLabsVoices()
      if (mounted.current) {
        setVoices(result)
      }
    } catch {
      if (mounted.current) {
        setError(
          translate(
            'elevenLabsVoice.listError',
            'Could not load voices. Check your key, Voices read permission, and connection.'
          )
        )
      }
    } finally {
      if (mounted.current) {
        setLoading(false)
      }
    }
  }

  function preview(): void {
    cancelPreview.current?.()
    cancelPreview.current = null
    if (previewing) {
      setPreviewing(false)
      return
    }
    setPreviewing(true)
    setError('')
    cancelPreview.current = playElevenLabsSpeech(
      {
        text: translate(
          'elevenLabsVoice.sample',
          'Hello. Let us calmly organize your ideas and decide what to do next.'
        ),
        voiceId,
        modelId
      },
      () => {
        if (mounted.current) {
          setPreviewing(false)
        }
      },
      () => {
        if (mounted.current) {
          setPreviewing(false)
          setError(
            translate(
              'elevenLabsVoice.previewError',
              'Preview failed. Check the voice ID, TTS permission, quota, and connection.'
            )
          )
        }
      }
    )
  }

  return (
    <section className="space-y-3 py-3" aria-labelledby={`${id}-title`}>
      <Label id={`${id}-title`}>
        {translate('elevenLabsVoice.title', 'ElevenLabs voice options')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {translate(
          'elevenLabsVoice.cost',
          'Optional cloud STT/TTS. Selected audio or reply text is sent to ElevenLabs. Account usage charges apply, including previews. Saving a key does not change your providers.'
        )}
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${id}-key`}>
          {translate('elevenLabsVoice.key', 'ElevenLabs API key')}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-key`}
            ref={keyInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="min-w-48 flex-1"
            value={draft}
            disabled={pending}
            placeholder={
              configured
                ? translate('elevenLabsVoice.configured', 'Key saved')
                : translate('elevenLabsVoice.enterKey', 'Enter your API key')
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim()) {
                void save()
              }
            }}
          />
          <Button
            size="sm"
            disabled={pending || loading || !draft.trim()}
            onClick={() => void save()}
          >
            {translate('elevenLabsVoice.save', 'Save key')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || loading || !configured}
            onClick={() => void save(true)}
          >
            {translate('elevenLabsVoice.remove', 'Remove key')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'elevenLabsVoice.storage',
            'The key is stored encrypted on this computer. Plaintext storage is not used. Enable Speech to Text / Text to Speech and Voices read permissions as needed.'
          )}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'elevenLabsVoice.stt',
          'For ElevenLabs STT, choose Scribe v2 Realtime in Speech Model above. You can combine local STT with ElevenLabs TTS.'
        )}
      </p>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={`${id}-provider`}>
          {translate('elevenLabsVoice.output', 'Response voice (TTS)')}
        </Label>
        <Select
          value={settings.ttsProvider ?? 'local'}
          onValueChange={(value) => {
            if (value === 'local' || value === 'elevenlabs') {
              onUpdate({ ttsProvider: value })
            }
          }}
        >
          <SelectTrigger id={`${id}-provider`} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">
              {translate('elevenLabsVoice.local', 'Local system voice · free')}
            </SelectItem>
            <SelectItem value="elevenlabs" disabled={!configured}>
              {translate('elevenLabsVoice.cloud', 'ElevenLabs · account usage')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {configured && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || pending}
              onClick={() => void loadVoices()}
            >
              {loading
                ? translate('elevenLabsVoice.loading', 'Loading…')
                : translate('elevenLabsVoice.load', 'Load my voices')}
            </Button>
            {voices.length > 0 && (
              <Select
                value={voices.some((voice) => voice.id === voiceId) ? voiceId : ''}
                onValueChange={(value) => onUpdate({ elevenLabsVoiceId: value })}
              >
                <SelectTrigger
                  className="w-64"
                  aria-label={translate('elevenLabsVoice.voice', 'Voice')}
                >
                  <SelectValue placeholder={translate('elevenLabsVoice.voice', 'Voice')} />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-voice`}>
              {translate(
                'elevenLabsVoice.voiceId',
                'Voice ID (or choose from your first 100 voices)'
              )}
            </Label>
            <Input
              id={`${id}-voice`}
              value={voiceId}
              maxLength={100}
              onChange={(event) => onUpdate({ elevenLabsVoiceId: event.target.value.trim() })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={modelId}
              onValueChange={(value) => {
                if (value === 'eleven_flash_v2_5' || value === 'eleven_multilingual_v2') {
                  onUpdate({ elevenLabsTtsModel: value })
                }
              }}
            >
              <SelectTrigger
                className="w-64"
                aria-label={translate('elevenLabsVoice.model', 'TTS model')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="eleven_flash_v2_5">
                  {translate('elevenLabsVoice.flash', 'Flash v2.5')}
                </SelectItem>
                <SelectItem value="eleven_multilingual_v2">
                  {translate('elevenLabsVoice.multilingual', 'Multilingual v2')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !/^[a-zA-Z0-9_-]{1,100}$/.test(voiceId)}
              onClick={preview}
            >
              {previewing
                ? translate('elevenLabsVoice.stop', 'Stop preview')
                : translate('elevenLabsVoice.preview', 'Preview · uses credits')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'elevenLabsVoice.tone',
              'Calm, clear delivery with a slightly slower pace. Preview a voice in your language before selecting it.'
            )}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
