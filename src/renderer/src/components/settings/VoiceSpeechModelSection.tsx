import { Fragment, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, KeyRound } from 'lucide-react'
import {
  getCloudSpeechProvider,
  isCloudSpeechProviderId,
  type CloudSpeechProviderId
} from '../../../../shared/cloud-speech-providers'
import type {
  VoiceSettings,
  SpeechModelManifest,
  SpeechModelProvider,
  SpeechModelState
} from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { groupSpeechModelsByProvider } from './voice-speech-model-groups'
import { describeSpeechIpcError } from './voice-speech-ipc-error'
import { VoiceSpeechModelMenuItem } from './VoiceSpeechModelMenuItem'

type VoiceSpeechModelSectionProps = {
  voiceSettings: VoiceSettings
  catalog: SpeechModelManifest[]
  modelStates: SpeechModelState[]
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  /** Opens the key dialog for a cloud model's provider; the model is selected once a key is saved. */
  onOpenCloudKeyDialog: (providerId: CloudSpeechProviderId, modelId: string) => void
  onRefreshModelStates: () => void
}

function getProviderGroupLabel(provider: SpeechModelProvider): string {
  if (provider === 'local') {
    return translate('auto.components.settings.VoiceSpeechModelSection.onDevice', 'On-device')
  }
  return isCloudSpeechProviderId(provider) ? getCloudSpeechProvider(provider).label : provider
}

export function VoiceSpeechModelSection({
  voiceSettings,
  catalog,
  modelStates,
  onUpdateVoiceSettings,
  onOpenCloudKeyDialog,
  onRefreshModelStates
}: VoiceSpeechModelSectionProps): React.JSX.Element {
  const [pendingDeleteModelIds, setPendingDeleteModelIds] = useState<Set<string>>(() => new Set())
  const getModelState = (id: string): SpeechModelState | undefined =>
    modelStates.find((s) => s.id === id)

  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const selectedModelState = voiceSettings.sttModel
    ? getModelState(voiceSettings.sttModel)
    : undefined
  const selectedIsReady = selectedModelState?.status === 'ready'
  const groups = groupSpeechModelsByProvider(catalog)

  const selectModel = (manifest: SpeechModelManifest, event: Event): void => {
    const state = getModelState(manifest.id)
    const isDownloading = state?.status === 'downloading' || state?.status === 'extracting'
    if (state?.status === 'ready') {
      onUpdateVoiceSettings({ sttModel: manifest.id })
    } else if (manifest.provider !== 'local') {
      // Why: a provider unknown to this renderer has no key dialog to open.
      if (isCloudSpeechProviderId(manifest.provider)) {
        onOpenCloudKeyDialog(manifest.provider, manifest.id)
      }
    } else if (!isDownloading) {
      // Why: download progress appears in this menu, so starting one should not dismiss it.
      event.preventDefault()
      void window.api.speech.downloadModel(manifest.id).catch((error: unknown) =>
        toast.error(
          translate('auto.components.settings.VoicePane.cfde55c7b0', 'Failed to download model.'),
          // Why: the raw cause (e.g. net::ERR_CONTENT_LENGTH_MISMATCH)
          // is the only diagnosable signal users can report back.
          { description: describeSpeechIpcError(error) }
        )
      )
    }
  }

  const setDeletePending = (modelId: string, pending: boolean): void => {
    setPendingDeleteModelIds((prev) => {
      const next = new Set(prev)
      if (pending) {
        next.add(modelId)
      } else {
        next.delete(modelId)
      }
      return next
    })
  }

  const deleteModel = (modelId: string): void => {
    setDeletePending(modelId, true)
    void window.api.speech
      .deleteModel(modelId)
      .then(onRefreshModelStates)
      .catch(() =>
        toast.error(
          translate('auto.components.settings.VoicePane.68de13f72c', 'Failed to delete model.')
        )
      )
      .finally(() => setDeletePending(modelId, false))
  }

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>{translate('auto.components.settings.VoicePane.43fd4f454b', 'Speech Model')}</Label>
        <p className="text-xs text-muted-foreground">
          {selectedModel && selectedIsReady
            ? `${selectedModel.label} — ${selectedModel.description}`
            : translate(
                'auto.components.settings.VoicePane.e24f7d43d2',
                'Select a speech model. Local models run offline; cloud models require an API key.'
              )}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!voiceSettings.enabled}
            className="max-w-56 shrink-0"
          >
            <span className="truncate">
              {selectedModel && selectedIsReady
                ? selectedModel.label
                : translate('auto.components.settings.VoicePane.fbe5990716', 'Select Model')}
            </span>
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-96">
          {groups.map((group, index) => (
            <Fragment key={group.provider}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>
                <div className="flex items-center justify-between gap-2">
                  <span>{getProviderGroupLabel(group.provider)}</span>
                  {/* Why: one key unlocks every model of a provider, so the prompt lives on the group. */}
                  {group.provider !== 'local' &&
                  !group.models.some((m) => getModelState(m.id)?.status === 'ready') ? (
                    <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                      <KeyRound className="size-3" />
                      {translate(
                        'auto.components.settings.VoiceSpeechModelSection.apiKeyNeeded',
                        'API key needed'
                      )}
                    </span>
                  ) : null}
                </div>
              </DropdownMenuLabel>
              {group.models.map((manifest) => (
                <VoiceSpeechModelMenuItem
                  key={manifest.id}
                  manifest={manifest}
                  state={getModelState(manifest.id)}
                  isActive={voiceSettings.sttModel === manifest.id}
                  deletePending={pendingDeleteModelIds.has(manifest.id)}
                  onSelect={(event) => selectModel(manifest, event)}
                  onDelete={() => deleteModel(manifest.id)}
                />
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
