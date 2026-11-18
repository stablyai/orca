import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type Props = {
  id: string
  project: string
  location: string
  /** Agent Platform fills empty fields from gcloud; Gemini Enterprise needs both. */
  optional: boolean
  disabled: boolean
  onProject: (value: string) => void
  onLocation: (value: string) => void
  onCommit: () => void
}

function commitOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    event.currentTarget.blur()
  }
}

/** The Google Cloud project and location an Antigravity account type reads. */
export function AntigravityChatGcpFields(props: Props): React.JSX.Element {
  const t = useTranslate()
  const { id, optional, disabled } = props
  return (
    <div className="space-y-1.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-project`}>
            {t('accounts.antigravity.gcpProject', 'Google Cloud project')}
          </Label>
          <Input
            id={`${id}-project`}
            value={props.project}
            disabled={disabled}
            placeholder={
              optional
                ? t('accounts.antigravity.projectFromGcloud', 'From gcloud')
                : t('accounts.antigravity.projectPlaceholder', 'my-project-id')
            }
            onChange={(event) => props.onProject(event.target.value)}
            onBlur={props.onCommit}
            onKeyDown={commitOnEnter}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-location`}>{t('accounts.antigravity.location', 'Location')}</Label>
          <Input
            id={`${id}-location`}
            value={props.location}
            disabled={disabled}
            placeholder={
              optional ? 'global' : t('accounts.antigravity.locationPlaceholder', 'us-central1')
            }
            onChange={(event) => props.onLocation(event.target.value)}
            onBlur={props.onCommit}
            onKeyDown={commitOnEnter}
          />
        </div>
      </div>
      {optional && (
        <p className="text-xs text-muted-foreground">
          {t(
            'accounts.antigravity.adcHint',
            'Optional. Orca uses your gcloud project and the global location. Run gcloud auth application-default login once first.'
          )}
        </p>
      )}
    </div>
  )
}
