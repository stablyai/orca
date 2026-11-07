import { useId, useState } from 'react'
import {
  getIrohRelayPreset,
  IROH_RELAY_PRESETS,
  parseIrohRelayUrl
} from '../../../../../../shared/iroh-relay-preference'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'

type RelayDraft = { source: string | null; custom: boolean; text: string; error: string | null }

/** Edit this computer's durable home relay while reconciling external preference changes. */
export function MobileIrohRelaySettingField(): React.JSX.Element {
  const source = useAppStore((state) => state.settings?.mobileIrohRelayUrl ?? null)
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const id = useId()
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<RelayDraft>({
    source,
    custom: getIrohRelayPreset(source) === 'custom',
    text: source ?? '',
    error: null
  })
  // Reconcile external preferences, including A -> B -> A, without reviving an old draft.
  const current =
    draft.source === source
      ? draft
      : {
          source,
          custom: getIrohRelayPreset(source) === 'custom',
          text: source ?? '',
          error: null
        }
  if (current !== draft) {
    setDraft(current)
  }

  /** Commit one preference write, retaining the previous selection if persistence fails. */
  const save = async (relayUrl: string | null): Promise<void> => {
    if (saving) {
      return
    }
    setSaving(true)
    setDraft({ ...current, error: null })
    try {
      if (relayUrl !== source) {
        await updateSettingsOrThrow({ mobileIrohRelayUrl: relayUrl })
      }
      setDraft({
        source: relayUrl,
        custom: getIrohRelayPreset(relayUrl) === 'custom',
        text: relayUrl ?? '',
        error: null
      })
    } catch {
      setDraft({
        ...current,
        error: translate(
          'auto.components.settings.MobileIrohRelaySettingField.saveFailed',
          'Could not save the home relay. Your previous preference is unchanged.'
        )
      })
    } finally {
      setSaving(false)
    }
  }

  /** Reject invalid or empty custom origins before invoking the settings writer. */
  const commitCustom = (): void => {
    let relayUrl: string | null
    try {
      relayUrl = parseIrohRelayUrl(current.text)
      if (relayUrl === null) {
        throw new Error('A custom relay requires an HTTPS origin')
      }
    } catch {
      setDraft({
        ...current,
        error: translate(
          'auto.components.settings.MobileIrohRelaySettingField.invalidOrigin',
          'Enter one HTTPS origin without credentials, a path, a query, or a fragment.'
        )
      })
      return
    }
    void save(relayUrl)
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border p-3"
      data-testid="mobile-iroh-relay-setting"
    >
      <Label htmlFor={`${id}-preset`}>
        {translate('auto.components.settings.MobileIrohRelaySettingField.label', 'Iroh home relay')}
      </Label>
      <Select
        value={current.custom ? 'custom' : getIrohRelayPreset(source)}
        disabled={saving}
        onValueChange={(value) => {
          if (value === 'custom') {
            setDraft({ ...current, custom: true, error: null })
            return
          }
          const preset = IROH_RELAY_PRESETS.find((item) => item.id === value)
          if (preset) {
            void save(preset.relayUrl)
          }
        }}
      >
        <SelectTrigger
          id={`${id}-preset`}
          size="sm"
          aria-describedby={`${id}-help${current.error ? ` ${id}-error` : ''}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="automatic">
            {translate(
              'auto.components.settings.MobileIrohRelaySettingField.automatic',
              'Automatic (N0)'
            )}
          </SelectItem>
          <SelectItem value="europe">
            {translate('auto.components.settings.MobileIrohRelaySettingField.europe', 'Europe')}
          </SelectItem>
          <SelectItem value="us-east">
            {translate('auto.components.settings.MobileIrohRelaySettingField.usEast', 'US East')}
          </SelectItem>
          <SelectItem value="us-west">
            {translate('auto.components.settings.MobileIrohRelaySettingField.usWest', 'US West')}
          </SelectItem>
          <SelectItem value="asia">
            {translate(
              'auto.components.settings.MobileIrohRelaySettingField.asia',
              'Asia (Singapore)'
            )}
          </SelectItem>
          <SelectItem value="custom">
            {translate(
              'auto.components.settings.MobileIrohRelaySettingField.custom',
              'Custom HTTPS'
            )}
          </SelectItem>
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.MobileIrohRelaySettingField.help',
          'Sets this computer’s Iroh home relay, not the phone’s. Saving reconnects Iroh and refreshes its pairing QR without unpairing devices.'
        )}
      </p>
      {current.custom ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-url`}>
            {translate(
              'auto.components.settings.MobileIrohRelaySettingField.customLabel',
              'Custom HTTPS relay origin'
            )}
          </Label>
          <div className="flex items-start gap-2">
            <Input
              id={`${id}-url`}
              value={current.text}
              disabled={saving}
              onChange={(event) => setDraft({ ...current, text: event.target.value, error: null })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitCustom()
                }
              }}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={current.error ? true : undefined}
              aria-describedby={`${id}-help${current.error ? ` ${id}-error` : ''}`}
              variant="code"
            />
            <Button size="sm" variant="outline" disabled={saving} onClick={commitCustom}>
              {translate('auto.components.settings.MobileIrohRelaySettingField.save', 'Save relay')}
            </Button>
          </div>
        </div>
      ) : null}
      {current.error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {current.error}
        </p>
      ) : null}
    </div>
  )
}
