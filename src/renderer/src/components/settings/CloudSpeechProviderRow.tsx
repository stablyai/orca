import { CheckCircle2, ExternalLink, Loader2, Unlink } from 'lucide-react'
import type {
  CloudSpeechKeyStatus,
  CloudSpeechProviderInfo
} from '../../../../shared/cloud-speech-providers'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { SettingsBadge } from './SettingsFormControls'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'
import type { CloudSpeechKeyTestState } from './voice-cloud-speech-keys'

type CloudSpeechProviderRowProps = {
  provider: CloudSpeechProviderInfo
  status: CloudSpeechKeyStatus | undefined
  pending: boolean
  test: CloudSpeechKeyTestState | undefined
  onConfigure: () => void
  onClear: () => void
  onTest: () => void
}

function CloudSpeechKeyTestVerdict({
  test
}: {
  test: CloudSpeechKeyTestState | undefined
}): React.JSX.Element | null {
  if (test?.status !== 'done') {
    return null
  }
  if (test.result.ok) {
    return (
      <p role="status" className="flex items-center gap-1 text-xs text-status-success">
        <CheckCircle2 className="size-3.5 shrink-0" />
        {translate('auto.components.settings.CloudSpeechProviderRow.keyWorks', 'Key works')}
      </p>
    )
  }
  return (
    <p role="alert" className="text-xs break-words text-destructive">
      {test.result.message ??
        translate(
          'auto.components.settings.CloudSpeechProviderRow.keyRejected',
          'The provider rejected this key.'
        )}
    </p>
  )
}

export function CloudSpeechProviderRow({
  provider,
  status,
  pending,
  test,
  onConfigure,
  onClear,
  onTest
}: CloudSpeechProviderRowProps): React.JSX.Element {
  const configured = status?.configured === true
  const testing = test?.status === 'testing'
  const removeLabel = translate(
    'auto.components.settings.CloudSpeechProviderRow.removeKey',
    'Remove {{provider}} API key',
    { provider: provider.label }
  )

  return (
    <div className="space-y-2 py-3">
      {/* Why: wraps the actions under the text instead of squeezing it on narrow windows. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-48 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{provider.label}</span>
            {configured ? (
              <SettingsBadge tone="accent">
                <span className="size-1.5 rounded-full bg-status-success" />
                {translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.3b0ab3fc0b',
                  'Connected'
                )}
                {status?.hint ? (
                  <span className="font-mono text-muted-foreground">{status.hint}</span>
                ) : null}
              </SettingsBadge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{provider.description}</p>
          <CloudSpeechKeyTestVerdict test={test} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {configured ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending || testing}
                onClick={onTest}
                className="w-16"
              >
                {testing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  translate('auto.components.settings.CloudSpeechProviderRow.test', 'Test')
                )}
              </Button>
              <Button variant="outline" size="sm" disabled={pending} onClick={onConfigure}>
                {translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.a622bc3b37',
                  'Replace key'
                )}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={removeLabel}
                    disabled={pending}
                    onClick={onClear}
                  >
                    {pending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Unlink className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {removeLabel}
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.api.shell.openUrl(provider.keyUrl)}
              >
                {translate(
                  'auto.components.settings.CloudSpeechProviderKeyDialog.getKey',
                  'Get API key'
                )}
                <ExternalLink className="size-3" />
              </Button>
              <Button variant="outline" size="sm" disabled={pending} onClick={onConfigure}>
                {translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61',
                  'Add API key'
                )}
              </Button>
            </>
          )}
        </div>
      </div>
      <UnsealedCredentialNotice
        protection={status?.protection ?? null}
        credentialName={translate(
          'auto.components.settings.CloudSpeechProviderRow.credentialName',
          'Your {{provider}} transcription key',
          { provider: provider.label }
        )}
      />
    </div>
  )
}
