import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SecretAtRestProtection } from '../../../../../shared/secure-storage/secret-at-rest-protection'
import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../../shared/speech/speech-types'
import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import { useTranslate } from '@/i18n/use-translate'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { OpenAiTranscriptionKeyDialog } from './OpenAiTranscriptionKeyDialog'
import { OpenAiTranscriptionSettingsRow } from './OpenAiTranscriptionSettingsRow'

type SonioxKeySetupOptions = {
  catalog: readonly SpeechModelManifest[]
  modelStates: readonly SpeechModelState[]
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  onRefreshModelStates: () => Promise<void> | void
}

type SonioxKeySetup = {
  /** Opens the key dialog; `modelId` is selected once the key is saved. */
  open: (modelId: string | null) => void
  /** The provider row under the cloud models, shown once a key is saved. */
  row: React.ReactNode
  dialog: React.ReactNode
}

/** The Soniox key's row and dialog; main reports the Soniox model ready once a key is saved. */
export function useSonioxKeySetup({
  catalog,
  modelStates,
  selectedModel,
  onUpdateVoiceSettings,
  onRefreshModelStates
}: SonioxKeySetupOptions): SonioxKeySetup {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [protection, setProtection] = useState<SecretAtRestProtection | null>(null)
  const [pendingModelId, setPendingModelId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const sonioxIds = new Set(catalog.filter((m) => m.provider === 'soniox').map((m) => m.id))
  const configured = modelStates.some((s) => sonioxIds.has(s.id) && s.status === 'ready')

  useEffect(() => {
    if (!configured) {
      setProtection(null)
      return
    }
    let cancelled = false
    void window.api.speech
      .getSonioxApiKeyStatus()
      .then((status) => {
        if (!cancelled) {
          setProtection(status.protection)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [configured])

  const open = (modelId: string | null): void => {
    setPendingModelId(modelId)
    setDraft('')
    setDialogOpen(true)
  }

  const run = async (action: () => Promise<void>, fallbackError: string): Promise<void> => {
    setPending(true)
    try {
      await action()
      await onRefreshModelStates()
      setDialogOpen(false)
      setDraft('')
      setPendingModelId(null)
    } catch (err) {
      toast.error(readIpcErrorMessage(err) ?? fallbackError)
    } finally {
      if (mountedRef.current) {
        setPending(false)
      }
    }
  }

  const save = (): Promise<void> =>
    run(
      async () => {
        const saved = await window.api.speech.saveSonioxApiKey(draft)
        // A replaced key may be sealed differently; `configured` doesn't flip, so the effect won't re-read it.
        setProtection(saved.protection)
        if (pendingModelId) {
          onUpdateVoiceSettings({ sttModel: pendingModelId })
        }
        toast.success(t('components.settings.voice.soniox.saved', 'Soniox API key saved'))
      },
      t('components.settings.voice.soniox.saveFailed', 'Failed to save Soniox API key')
    )

  const clear = (): Promise<void> =>
    run(
      async () => {
        await window.api.speech.clearSonioxApiKey()
        // Dictation can't use the Soniox model without its key.
        if (selectedModel?.provider === 'soniox') {
          onUpdateVoiceSettings({ sttModel: '' })
        }
        toast.success(t('components.settings.voice.soniox.cleared', 'Soniox API key cleared'))
      },
      t('components.settings.voice.soniox.clearFailed', 'Failed to clear Soniox API key')
    )

  const row = configured ? (
    <>
      <div data-settings-row="" className="py-3 empty:hidden">
        <UnsealedCredentialNotice
          protection={protection}
          credentialName={t('components.settings.voice.soniox.keyName', 'Your Soniox key')}
        />
      </div>
      <OpenAiTranscriptionSettingsRow
        variant="soniox"
        configured
        disabled={pending}
        onConfigure={() => open(null)}
        onClear={() => void clear()}
      />
    </>
  ) : null

  const dialog = (
    <OpenAiTranscriptionKeyDialog
      provider="soniox"
      open={dialogOpen}
      configured={configured}
      apiKeyDraft={draft}
      pending={pending}
      onOpenChange={setDialogOpen}
      onApiKeyDraftChange={setDraft}
      onSave={() => void save()}
      onClear={() => void clear()}
    />
  )

  return { open, row, dialog }
}
