import { useEffect, useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import type {
  PluginSettingContribution,
  PluginSettingValue
} from '../../../../../shared/plugins/contributions/plugin-settings-contribution'
import { translate } from '@/i18n/i18n'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Textarea } from '../../ui/textarea'
import { SettingsSwitch } from '../../settings/SettingsFormControls'
import { DetailSection } from './PluginDetailSections'

type Values = Record<string, PluginSettingValue>

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function PluginSettingField({
  setting,
  value,
  onCommit
}: {
  setting: PluginSettingContribution
  value: PluginSettingValue | undefined
  onCommit: (value: PluginSettingValue | null) => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(typeof value === 'string' ? value : '')
  const defaultText =
    setting.default === undefined || setting.default === '' ? null : String(setting.default)
  // Why: an empty text field means "use the plugin's default", so it resets instead of storing ''.
  const commitText = (): void => {
    if (draft !== (typeof value === 'string' ? value : '')) {
      onCommit(draft === '' ? null : draft)
    }
  }
  const checked = typeof value === 'boolean' ? value : setting.default === true
  const control =
    setting.type === 'boolean' ? (
      <SettingsSwitch
        checked={checked}
        onChange={() => onCommit(!checked)}
        ariaLabel={setting.title}
      />
    ) : setting.type === 'enum' ? (
      <Select
        value={typeof value === 'string' ? value : String(setting.default ?? '')}
        onValueChange={(next) => onCommit(next)}
      >
        <SelectTrigger id={id} aria-label={setting.title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
          {(setting.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : setting.multiline ? (
      <Textarea
        id={id}
        value={draft}
        placeholder={setting.placeholder ?? defaultText ?? undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitText}
        rows={4}
      />
    ) : (
      <Input
        id={id}
        value={draft}
        placeholder={setting.placeholder ?? defaultText ?? undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            commitText()
          }
        }}
        spellCheck={false}
      />
    )
  const labelGroup = (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={setting.type === 'boolean' ? undefined : id}>{setting.title}</Label>
      {setting.description ? (
        <p className="text-xs text-muted-foreground">{setting.description}</p>
      ) : null}
    </div>
  )
  if (setting.type === 'boolean') {
    // Why: switches sit beside their label, matching SettingsSwitchRow elsewhere in Settings.
    return (
      <div className="flex items-start justify-between gap-4 border-t border-border px-3.5 py-3 first:border-t-0">
        {labelGroup}
        <div className="shrink-0 pt-0.5">{control}</div>
      </div>
    )
  }
  return (
    <div className="space-y-2 border-t border-border px-3.5 py-3 first:border-t-0">
      {labelGroup}
      {control}
      {defaultText && setting.type === 'string' ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.PluginSettingsSection.default',
            'Default: {{value0}}',
            {
              value0: defaultText
            }
          )}
        </p>
      ) : null}
    </div>
  )
}

/** The plugin's declared settings on its page; each change saves on its own. */
export function PluginSettingsSection({
  plugin
}: {
  plugin: PluginHostListEntry
}): React.JSX.Element {
  const [values, setValues] = useState<Values | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { pluginKey } = plugin

  useEffect(() => {
    let cancelled = false
    setValues(null)
    setError(null)
    window.api.plugins
      .readSettings({ pluginKey })
      .then((next) => {
        if (!cancelled) {
          setValues(next)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorText(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [pluginKey])

  const commit = (key: string, value: PluginSettingValue | null): void => {
    setError(null)
    window.api.plugins
      .writeSetting({ pluginKey, key, value })
      .then(setValues)
      .catch((cause: unknown) => setError(errorText(cause)))
  }

  return (
    <DetailSection
      title={translate('auto.components.settings.PluginSettingsSection.title', 'Settings')}
    >
      {values === null && !error ? (
        <p className="flex items-center gap-2 px-3.5 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate('auto.components.settings.PluginSettingsSection.loading', 'Loading…')}
        </p>
      ) : null}
      {values
        ? (plugin.settings ?? []).map((setting) => (
            <PluginSettingField
              key={setting.key}
              setting={setting}
              value={values[setting.key]}
              onCommit={(value) => commit(setting.key, value)}
            />
          ))
        : null}
      {error ? (
        <p
          role="alert"
          className="border-t border-border px-3.5 py-3 text-xs text-destructive first:border-t-0"
        >
          {error}
        </p>
      ) : null}
    </DetailSection>
  )
}
