import { useEffect, useId, useState } from 'react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import type {
  PluginSettingContribution,
  PluginSettingValue
} from '../../../../shared/plugins/plugin-settings-contribution'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import { SettingsSwitch } from './SettingsFormControls'

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
      <div className="flex items-start justify-between gap-4">
        {labelGroup}
        <div className="shrink-0 pt-0.5">{control}</div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {labelGroup}
      {control}
      {defaultText && setting.type === 'string' ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.PluginSettingsDialog.default',
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

/** Edits a plugin's declared settings; each change saves on its own. */
export function PluginSettingsDialog({
  plugin,
  onClose
}: {
  plugin: PluginHostListEntry | null
  onClose: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<Values | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pluginKey = plugin?.pluginKey ?? null

  useEffect(() => {
    if (!pluginKey) {
      return
    }
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
    if (!pluginKey) {
      return
    }
    setError(null)
    window.api.plugins
      .writeSetting({ pluginKey, key, value })
      .then(setValues)
      .catch((cause: unknown) => setError(errorText(cause)))
  }

  const settings = plugin?.settings ?? []
  return (
    <Dialog open={plugin !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginSettingsDialog.title',
              '{{value0}} settings',
              { value0: plugin?.name ?? '' }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginSettingsDialog.description',
              'Each change saves on its own. The plugin uses it the next time it reads its settings.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 scrollbar-sleek">
          {values === null && !error ? (
            <p className="text-sm text-muted-foreground">
              {translate('auto.components.settings.PluginSettingsDialog.loading', 'Loading…')}
            </p>
          ) : null}
          {values
            ? settings.map((setting) => (
                <PluginSettingField
                  key={setting.key}
                  setting={setting}
                  value={values[setting.key]}
                  onCommit={(value) => commit(setting.key, value)}
                />
              ))
            : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {translate('auto.components.settings.PluginSettingsDialog.done', 'Done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
