import { useTranslate } from '@/i18n/use-translate'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'

/** Label, status badge and paste/Replace/Clear row shared by the API-key usage providers. */
export function UsageApiKeyField({
  inputId,
  label,
  placeholder,
  badgeLabel,
  configured,
  draft,
  onDraftChange,
  disabled,
  onSave,
  onClear,
  notice,
  retry
}: {
  inputId: string
  label: string
  placeholder: string
  badgeLabel: string
  configured: boolean
  draft: string
  onDraftChange: (value: string) => void
  /** Locks the input, Save and Clear (busy, or the host is not writable). */
  disabled: boolean
  onSave: () => void
  onClear: () => void
  notice?: string | null
  retry?: { label: string; disabled: boolean; onClick: () => void } | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Badge variant={configured ? 'secondary' : 'outline'}>{badgeLabel}</Badge>
      </div>
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      <div className="flex gap-2">
        <Input
          id={inputId}
          type="password"
          value={draft}
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="flex-1"
        />
        {retry && (
          <Button size="xs" variant="outline" disabled={retry.disabled} onClick={retry.onClick}>
            {retry.label}
          </Button>
        )}
        <Button size="xs" disabled={disabled || !draft.trim()} onClick={onSave}>
          {configured
            ? t('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
            : t('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
        </Button>
        {configured && (
          <Button variant="ghost" size="xs" disabled={disabled} onClick={onClear}>
            {t('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
          </Button>
        )}
      </div>
    </>
  )
}
