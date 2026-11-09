import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  AGENT_API_KEY_PRESETS,
  agentApiKeyEnvNameError,
  agentApiKeyValueError,
  type AgentApiKeySaveRequest,
  type AgentApiKeySummary
} from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { HostListOverflowNote } from '../../host-picker/HostListOverflowNote'
import { HostListSearchField } from '../../host-picker/HostListSearchField'
import { useBoundedHostRows } from '../../host-picker/use-bounded-host-rows'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

export type AgentApiKeyHostChoice = {
  id: ExecutionHostId
  label: string
  /** Other ids the same machine answers to (an SSH host that also runs an Orca server). */
  aliasHostIds?: readonly ExecutionHostId[]
}

const OTHER_VARIABLE = '__other__'

function hostIdsFor(choice: AgentApiKeyHostChoice): ExecutionHostId[] {
  return [choice.id, ...(choice.aliasHostIds ?? [])]
}

export function AgentApiKeyEditor({
  agent,
  initial,
  hosts,
  onSave,
  onCancel
}: {
  agent: TuiAgent
  initial?: AgentApiKeySummary
  hosts: readonly AgentApiKeyHostChoice[]
  onSave: (request: AgentApiKeySaveRequest) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const presets = AGENT_API_KEY_PRESETS[agent] ?? []
  const initialPreset = presets.find((preset) => preset.envName === (initial?.envName ?? ''))
  const [variable, setVariable] = useState<string>(
    initial
      ? initialPreset
        ? initial.envName
        : OTHER_VARIABLE
      : (presets[0]?.envName ?? OTHER_VARIABLE)
  )
  const [customName, setCustomName] = useState(initialPreset ? '' : (initial?.envName ?? ''))
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<'all' | 'hosts'>(initial?.hostScope.kind ?? 'all')
  const [selected, setSelected] = useState<ReadonlySet<ExecutionHostId>>(
    () => new Set(initial?.hostScope.kind === 'hosts' ? initial.hostScope.hostIds : [])
  )
  const [error, setError] = useState<string | null>(null)
  // Pin checked hosts so they stay visible to uncheck when the list is capped.
  const hostRows = useBoundedHostRows(hosts, selected)
  const [saving, setSaving] = useState(false)

  const envName = variable === OTHER_VARIABLE ? customName.trim().toUpperCase() : variable
  const preset = presets.find((entry) => entry.envName === envName)
  const keepsValue = initial !== undefined && value.trim() === ''

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = value.trim()
    const problem =
      agentApiKeyEnvNameError(envName) ??
      (keepsValue ? null : agentApiKeyValueError(envName, trimmed)) ??
      (scope === 'hosts' && selected.size === 0
        ? t('auto.components.settings.agentApiKeys.editor.noHosts', 'Choose at least one host.')
        : null)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    const failure = await onSave({
      ...(initial ? { id: initial.id } : {}),
      agent,
      envName,
      ...(keepsValue ? {} : { value: trimmed }),
      hostScope: scope === 'all' ? { kind: 'all' } : { kind: 'hosts', hostIds: [...selected] }
    })
    setSaving(false)
    // Why clear on success too: the value must not linger in renderer state after it's sealed.
    setValue('')
    if (failure) {
      setError(failure)
    }
  }

  const toggleHost = (choice: AgentApiKeyHostChoice, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const id of hostIdsFor(choice)) {
        if (checked) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }
      return next
    })
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="space-y-4 rounded-lg border border-border bg-background/60 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-variable`} variant="settings">
            {t('auto.components.settings.agentApiKeys.editor.variable', 'Variable')}
          </Label>
          {presets.length > 0 ? (
            <Select value={variable} onValueChange={setVariable} disabled={initial !== undefined}>
              <SelectTrigger id={`${formId}-variable`} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((entry) => (
                  <SelectItem key={entry.envName} value={entry.envName}>
                    {entry.envName}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_VARIABLE}>
                  {t(
                    'auto.components.settings.agentApiKeys.editor.otherVariable',
                    'Other variable…'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          {variable === OTHER_VARIABLE ? (
            <Input
              id={presets.length > 0 ? `${formId}-custom` : `${formId}-variable`}
              aria-label={t(
                'auto.components.settings.agentApiKeys.editor.variableName',
                'Variable name'
              )}
              variant="code"
              disabled={initial !== undefined}
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t(
                'auto.components.settings.agentApiKeys.editor.customPlaceholder',
                'MY_PROVIDER_API_KEY'
              )}
              spellCheck={false}
              autoComplete="off"
              className="h-8"
            />
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-value`} variant="settings">
            {preset?.label ?? t('auto.components.settings.agentApiKeys.editor.value', 'Key')}
          </Label>
          <Input
            id={`${formId}-value`}
            type="password"
            variant="code"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              initial
                ? t(
                    'auto.components.settings.agentApiKeys.editor.keepValue',
                    'Leave empty to keep ••••{{hint}}',
                    { hint: initial.hint }
                  )
                : (preset?.placeholder ?? '')
            }
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore=""
            className="h-8"
          />
        </div>
      </div>

      <div className="space-y-2">
        <p id={`${formId}-where`} className="text-xs text-muted-foreground">
          {t('auto.components.settings.agentApiKeys.editor.where', 'Use it on')}
        </p>
        <RadioGroup
          value={scope}
          onValueChange={(next) => setScope(next === 'hosts' ? 'hosts' : 'all')}
          aria-labelledby={`${formId}-where`}
        >
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <RadioGroupItem value="all" />
            {t('auto.components.settings.agentApiKeys.editor.allHosts', 'Every host')}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <RadioGroupItem value="hosts" />
            {t('auto.components.settings.agentApiKeys.editor.someHosts', 'Only these hosts')}
          </label>
        </RadioGroup>
        {scope === 'hosts' ? (
          <div className="space-y-1.5 pl-6">
            {hostRows.searchable ? (
              <HostListSearchField value={hostRows.query} onChange={hostRows.setQuery} />
            ) : null}
            <div
              role="group"
              aria-labelledby={`${formId}-where`}
              className="grid gap-1.5 sm:grid-cols-2"
            >
              {hostRows.shown.map((choice) => (
                <label
                  key={choice.id}
                  className="flex min-w-0 cursor-pointer items-center gap-2 text-xs"
                >
                  <Checkbox
                    checked={selected.has(choice.id)}
                    onCheckedChange={(checked) => toggleHost(choice, checked === true)}
                  />
                  <span className="truncate">{choice.label}</span>
                </label>
              ))}
            </div>
            <HostListOverflowNote hiddenCount={hostRows.hiddenCount} />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="min-h-4 text-xs text-destructive">
          {error}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {t('auto.components.settings.agentApiKeys.editor.cancel', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {initial
              ? t('auto.components.settings.agentApiKeys.editor.update', 'Save')
              : t('auto.components.settings.agentApiKeys.editor.add', 'Add key')}
          </Button>
        </div>
      </div>
    </form>
  )
}
