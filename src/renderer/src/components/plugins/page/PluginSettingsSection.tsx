import { useId, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Textarea } from '../../ui/textarea'
import type { PluginSettingContribution } from '../../../../../shared/plugins/contributions/plugin-settings-contribution'
import type { PluginJsonValue } from '../../../../../shared/plugins/workers/plugin-host-api'
import { DetailSection } from './PluginDetailSections'
import { usePluginDeclaredSettings } from '../state/use-plugin-declared-settings'

type SettingControlProps = {
  id: string
  setting: PluginSettingContribution
  value: PluginJsonValue | undefined
  onCommit: (value: PluginJsonValue) => void
}

/** Text and numbers commit on blur or Enter, so a half-typed value is never written. */
function TextSetting({ id, setting, value, onCommit }: SettingControlProps): React.JSX.Element {
  const shown = value === undefined || value === null ? '' : String(value)
  const [draft, setDraft] = useState<string | null>(null)
  const numeric = setting.type === 'number' || setting.type === 'integer'
  const commit = (): void => {
    if (draft === null || draft === shown) {
      setDraft(null)
      return
    }
    // An emptied field goes back to the default.
    onCommit(draft === '' ? null : numeric ? Number(draft) : draft)
    setDraft(null)
  }
  const shared = {
    id,
    value: draft ?? shown,
    placeholder: setting.placeholder,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit
  }
  return setting.multiline ? (
    <Textarea {...shared} rows={3} />
  ) : (
    <Input
      {...shared}
      type={numeric ? 'number' : 'text'}
      min={setting.minimum}
      max={setting.maximum}
      step={setting.type === 'integer' ? 1 : undefined}
      maxLength={setting.maxLength}
      density="compact"
      className="w-56"
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit()
        }
      }}
    />
  )
}

function SettingControl(props: SettingControlProps): React.JSX.Element {
  const { id, setting, value, onCommit } = props
  if (setting.type === 'boolean') {
    return (
      <Switch id={id} checked={value === true} onCheckedChange={(checked) => onCommit(checked)} />
    )
  }
  if (setting.enum) {
    const options = setting.enum.map((option, index) => ({
      value: String(option),
      raw: option,
      label: setting.enumLabels?.[index] ?? String(option)
    }))
    return (
      <Select
        value={value === undefined || value === null ? undefined : String(value)}
        onValueChange={(next) => {
          const option = options.find((entry) => entry.value === next)
          if (option) {
            onCommit(option.raw)
          }
        }}
      >
        <SelectTrigger id={id} size="sm" className="w-56">
          <SelectValue placeholder={setting.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return <TextSetting {...props} />
}

function SettingRow({
  setting,
  value,
  error,
  onWrite
}: {
  setting: PluginSettingContribution
  value: PluginJsonValue | undefined
  error: string | undefined
  onWrite: (value: PluginJsonValue) => void
}): React.JSX.Element {
  const id = useId()
  const changed = value !== undefined && value !== (setting.default ?? undefined)
  const stacked = setting.multiline === true
  return (
    <div className="border-t border-border px-3.5 py-2.5 text-sm first:border-t-0">
      <div
        data-stacked={stacked}
        className="flex items-center gap-3 data-[stacked=true]:flex-col data-[stacked=true]:items-stretch"
      >
        <div className="min-w-0 flex-1">
          <Label htmlFor={id}>{setting.title}</Label>
          {setting.description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SettingControl id={id} setting={setting} value={value} onCommit={onWrite} />
          {changed && setting.default !== undefined ? (
            <Button variant="ghost" size="xs" onClick={() => onWrite(null)}>
              {translate('auto.components.settings.PluginSettingsSection.reset', 'Reset')}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/** `contributes.settings`, edited here by the person; the plugin reads them with `settings.get`. */
export function PluginSettingsSection({
  pluginKey,
  revision
}: {
  pluginKey: string
  /** Re-reads when the installed plugin changes. */
  revision: string
}): React.JSX.Element | null {
  const { snapshot, errors, write } = usePluginDeclaredSettings(pluginKey, revision)
  if (!snapshot || snapshot.settings.length === 0) {
    return null
  }
  return (
    <DetailSection
      title={translate('auto.components.settings.PluginSettingsSection.title', 'Settings')}
    >
      {snapshot.settings.map((setting) => (
        <SettingRow
          key={setting.key}
          setting={setting}
          value={snapshot.values[setting.key]}
          error={errors[setting.key]}
          onWrite={(value) => write(setting.key, value)}
        />
      ))}
    </DetailSection>
  )
}
