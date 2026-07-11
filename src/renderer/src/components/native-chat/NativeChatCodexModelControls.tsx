import { Brain, LoaderCircle } from 'lucide-react'
import type { CommitMessageModelCapability } from '../../../../shared/commit-message-agent-spec'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export type NativeChatCodexModelControlsProps = {
  models: readonly CommitMessageModelCapability[]
  modelId: string | null
  effortId: string | null
  loading: boolean
  applying: boolean
  disabled: boolean
  error: string | null
  onModelChange: (modelId: string) => void
  onEffortChange: (effortId: string) => void
  onApply: () => void
}

export function NativeChatCodexModelControls({
  models,
  modelId,
  effortId,
  loading,
  applying,
  disabled,
  error,
  onModelChange,
  onEffortChange,
  onApply
}: NativeChatCodexModelControlsProps): React.JSX.Element {
  const selectedModel = models.find((model) => model.id === modelId) ?? null
  const efforts = selectedModel?.thinkingLevels ?? []
  const selectedEffort = efforts.find((effort) => effort.id === effortId) ?? null
  const busy = loading || applying
  const triggerLabel = selectedModel
    ? [selectedModel.label, selectedEffort?.label].filter(Boolean).join(' · ')
    : translate('components.native-chat.composer.model', 'Model')

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 max-w-56 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={disabled}
          aria-label={translate(
            'components.native-chat.composer.openModelPicker',
            'Choose model and reasoning'
          )}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Brain className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-3">
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-xs font-medium">
            {translate('components.native-chat.composer.model', 'Model')}
            <Select value={modelId ?? undefined} onValueChange={onModelChange} disabled={busy}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue
                  placeholder={translate('components.native-chat.composer.selectModel', 'Select')}
                />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {efforts.length > 0 ? (
            <label className="grid gap-1.5 text-xs font-medium">
              {translate('components.native-chat.composer.reasoning', 'Reasoning')}
              <Select value={effortId ?? undefined} onValueChange={onEffortChange} disabled={busy}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue
                    placeholder={translate(
                      'components.native-chat.composer.selectReasoning',
                      'Select'
                    )}
                  />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {efforts.map((effort) => (
                    <SelectItem key={effort.id} value={effort.id}>
                      {effort.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={busy || !selectedModel || (efforts.length > 0 && !effortId)}
            onClick={onApply}
          >
            {applying
              ? translate('components.native-chat.composer.applyingModel', 'Applying…')
              : translate('components.native-chat.composer.applyModel', 'Apply')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
