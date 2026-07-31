import { useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  normalizeCodexMicroSettings,
  type CodexMicroDialMode,
  type CodexMicroSettings
} from '../../../../../shared/codex-micro-settings'
import {
  CODEX_MICRO_CONTROL_IDS,
  type CodexMicroConnectionState,
  type CodexMicroControlId
} from '../../../../../shared/codex-micro-types'
import { KEYBINDING_DEFINITIONS, type KeybindingActionId } from '../../../../../shared/keybindings'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { Input } from '../../ui/input'
import { Slider } from '../../ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitch,
  SettingsSwitchRow
} from '../SettingsFormControls'
import { translate } from '@/i18n/i18n'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const UNASSIGNED = '__unassigned__'

export function CodexMicroSettingsPane({ settings, updateSettings }: Props): React.JSX.Element {
  const device = normalizeCodexMicroSettings(settings.codexMicro)
  const [connection, setConnection] = useState<CodexMicroConnectionState | null>(null)
  const [actionFilter, setActionFilter] = useState('')

  useEffect(() => {
    let active = true
    void window.api.codexMicro?.getState().then((state) => {
      if (active) {
        setConnection(state)
      }
    })
    const unsubscribe = window.api.codexMicro?.subscribeState((state) => setConnection(state))
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const updateDevice = (updates: Partial<CodexMicroSettings>): void => {
    updateSettings({ codexMicro: { ...device, ...updates } })
  }
  const writable = connection?.kind === 'connected'
  const actionOptions = useMemo(() => {
    const query = actionFilter.trim().toLowerCase()
    return query
      ? KEYBINDING_DEFINITIONS.filter(
          (definition) =>
            definition.title.toLowerCase().includes(query) ||
            definition.group.toLowerCase().includes(query) ||
            definition.id.toLowerCase().includes(query)
        )
      : KEYBINDING_DEFINITIONS
  }, [actionFilter])

  return (
    <div className="space-y-5">
      <Card className="gap-0 p-4 shadow-xs">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              {connection
                ? connectionLabel(connection)
                : translate(
                    'auto.components.settings.codexMicro.checkingDevice',
                    'Checking device'
                  )}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connection
                ? connectionDescription(connection)
                : translate(
                    'auto.components.settings.codexMicro.checkingDescription',
                    'Reading the current connection state.'
                  )}
            </p>
          </div>
          <div className="flex gap-2">
            {connection &&
            connection.kind !== 'disabled' &&
            connection.kind !== 'connected' &&
            connection.kind !== 'connecting' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void window.api.codexMicro?.retry()}
              >
                {translate('auto.components.settings.codexMicro.retry', 'Retry')}
              </Button>
            ) : null}
            {connection?.kind === 'connecting' ||
            connection?.kind === 'connected' ||
            connection?.kind === 'read-only' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void window.api.codexMicro?.release()}
              >
                {translate('auto.components.settings.codexMicro.release', 'Release')}
              </Button>
            ) : null}
          </div>
        </div>
        {connection && 'code' in connection ? (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {translate('auto.components.settings.codexMicro.diagnostics', 'Diagnostics')}
            </summary>
            <p className="mt-2 font-mono">{connection.code}</p>
            <p>{connection.message}</p>
          </details>
        ) : null}
      </Card>

      <div className="divide-y divide-border">
        <SettingsSwitchRow
          label={translate('auto.components.settings.codexMicro.useWithOrca', 'Use with Orca')}
          description={translate(
            'auto.components.settings.codexMicro.useWithOrcaDescription',
            'Allow Orca to connect to the Codex Micro over USB.'
          )}
          checked={device.enabled}
          onChange={() => updateDevice({ enabled: !device.enabled })}
        />
        <SettingsRow
          label={translate('auto.components.settings.codexMicro.lighting', 'Lighting')}
          description={translate(
            'auto.components.settings.codexMicro.lightingDescription',
            'Enable device lighting on known writable firmware.'
          )}
          control={
            <SettingsSwitch
              checked={device.lightingEnabled}
              disabled={!writable}
              onChange={() => updateDevice({ lightingEnabled: !device.lightingEnabled })}
              ariaLabel={translate('auto.components.settings.codexMicro.lighting', 'Lighting')}
            />
          }
        />
        <SettingsRow
          label={translate('auto.components.settings.codexMicro.brightness', 'Brightness')}
          description={`${device.brightness}%`}
          control={
            <Slider
              className="w-36"
              min={0}
              max={100}
              step={1}
              value={[device.brightness]}
              disabled={!writable || !device.lightingEnabled}
              aria-label={translate('auto.components.settings.codexMicro.brightness', 'Brightness')}
              onValueChange={([brightness]) => updateDevice({ brightness: brightness ?? 0 })}
            />
          }
        />
        <SettingsRow
          label={translate(
            'auto.components.settings.codexMicro.idleTimeout',
            'Lighting idle timeout'
          )}
          description={translate(
            'auto.components.settings.codexMicro.idleTimeoutDescription',
            'Seconds before lighting becomes idle.'
          )}
          control={
            <Input
              className="w-24"
              type="number"
              min={10}
              max={3600}
              disabled={!writable || !device.lightingEnabled}
              aria-label={translate(
                'auto.components.settings.codexMicro.idleTimeout',
                'Lighting idle timeout'
              )}
              value={device.idleTimeoutSeconds}
              onChange={(event) =>
                updateDevice({ idleTimeoutSeconds: Number(event.currentTarget.value) })
              }
            />
          }
        />
        <SettingsRow
          label={translate('auto.components.settings.codexMicro.dialMode', 'Dial mode')}
          control={
            <SettingsSegmentedControl<CodexMicroDialMode>
              value={device.dialMode}
              ariaLabel={translate('auto.components.settings.codexMicro.dialMode', 'Dial mode')}
              onChange={(dialMode) => updateDevice({ dialMode })}
              options={[
                {
                  value: 'navigate',
                  label: translate('auto.components.settings.codexMicro.navigate', 'Navigate')
                },
                {
                  value: 'scroll',
                  label: translate('auto.components.settings.codexMicro.scroll', 'Scroll')
                }
              ]}
            />
          }
        />
      </div>

      <div className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.codexMicro.mappings', 'Control mappings')}
          description={translate(
            'auto.components.settings.codexMicro.mappingsDescription',
            'Map buttons and dial gestures to existing Orca commands.'
          )}
        />
        <Input
          value={actionFilter}
          onChange={(event) => setActionFilter(event.currentTarget.value)}
          aria-label={translate(
            'auto.components.settings.codexMicro.filterActions',
            'Filter actions'
          )}
          placeholder={translate(
            'auto.components.settings.codexMicro.filterActions',
            'Filter actions'
          )}
        />
        <div className="grid gap-2 md:grid-cols-2">
          {CODEX_MICRO_CONTROL_IDS.map((control) => (
            <MappingSelect
              key={control}
              control={control}
              value={device.mappings[control]}
              options={actionOptions}
              onChange={(actionId) =>
                updateDevice({
                  mappings: updateMapping(device.mappings, control, actionId)
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function MappingSelect({
  control,
  value,
  options,
  onChange
}: {
  control: CodexMicroControlId
  value: KeybindingActionId | undefined
  options: typeof KEYBINDING_DEFINITIONS
  onChange: (value: KeybindingActionId | undefined) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-2">
      <span id={`codex-control-${control}`} className="w-20 font-mono text-xs">
        {control}
      </span>
      <Select
        value={value ?? UNASSIGNED}
        onValueChange={(next) =>
          onChange(next === UNASSIGNED ? undefined : (next as KeybindingActionId))
        }
      >
        <SelectTrigger className="min-w-0 flex-1" aria-labelledby={`codex-control-${control}`}>
          <SelectValue
            placeholder={translate('auto.components.settings.codexMicro.unassigned', 'Unassigned')}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>
            {translate('auto.components.settings.codexMicro.unassigned', 'Unassigned')}
          </SelectItem>
          {options.map((definition) => (
            <SelectItem key={definition.id} value={definition.id}>
              {definition.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function updateMapping(
  mappings: CodexMicroSettings['mappings'],
  control: CodexMicroControlId,
  actionId: KeybindingActionId | undefined
): CodexMicroSettings['mappings'] {
  const next = { ...mappings }
  if (actionId) {
    next[control] = actionId
  } else {
    delete next[control]
  }
  return next
}

function connectionLabel(state: CodexMicroConnectionState): string {
  const labels: Record<CodexMicroConnectionState['kind'], string> = {
    disabled: translate('auto.components.settings.codexMicro.statusDisabled', 'Not in use'),
    disconnected: translate(
      'auto.components.settings.codexMicro.statusDisconnected',
      'Disconnected'
    ),
    connecting: translate('auto.components.settings.codexMicro.statusConnecting', 'Connecting'),
    connected: translate('auto.components.settings.codexMicro.statusConnected', 'Connected'),
    'read-only': translate('auto.components.settings.codexMicro.statusReadOnly', 'Read-only'),
    conflict: translate('auto.components.settings.codexMicro.statusConflict', 'Device in use'),
    'permission-error': translate(
      'auto.components.settings.codexMicro.statusPermission',
      'Permission required'
    ),
    error: translate('auto.components.settings.codexMicro.statusError', 'Device error')
  }
  return labels[state.kind]
}

function connectionDescription(state: CodexMicroConnectionState): string {
  if (state.kind === 'disabled') {
    return translate(
      'auto.components.settings.codexMicro.disabledDescription',
      'Turn on Use with Orca, then connect the Codex Micro by USB.'
    )
  }
  if (state.kind === 'connected') {
    return `${state.firmware}${state.battery !== undefined ? ` · ${state.battery}%` : ''}`
  }
  if (state.kind === 'read-only') {
    return translate(
      'auto.components.settings.codexMicro.readOnlyDescription',
      'Inputs work, but output controls are disabled for this firmware.'
    )
  }
  if (state.kind === 'error' || state.kind === 'permission-error' || state.kind === 'conflict') {
    return state.message
  }
  return translate(
    'auto.components.settings.codexMicro.connectionDescription',
    'Connect the Codex Micro by USB to use it with Orca.'
  )
}

export { updateMapping }
