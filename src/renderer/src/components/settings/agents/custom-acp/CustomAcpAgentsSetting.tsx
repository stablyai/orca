// Settings > Agents: local ACP commands this machine runs as Chat agents.

import { useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  normalizeCustomAcpAgents,
  type CustomAcpAgent
} from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { useTranslate } from '@/i18n/use-translate'
import { reloadLocalHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents-sync'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { cn } from '@/lib/class-names'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  customAcpAgentCommandLine,
  customAcpAgentDraftFrom,
  customAcpAgentDraftProblems,
  draftRowKey,
  emptyCustomAcpAgentDraft,
  saveCustomAcpAgentDraft,
  type CustomAcpAgentDraft,
  type CustomAcpEnvRow
} from './custom-acp-agent-draft'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const randomSuffix = (): string => createNonSecureContextUuid().replace(/-/g, '')

export function CustomAcpAgentsSetting({ settings, updateSettings }: Props): React.JSX.Element {
  const t = useTranslate()
  const saved = normalizeCustomAcpAgents(settings.customAcpAgents)
  const [draft, setDraft] = useState<CustomAcpAgentDraft | null>(null)
  const save = (next: CustomAcpAgent[]): void => {
    // New chats list this machine's agents from its runtime, which reads the saved settings.
    void Promise.resolve(updateSettings({ customAcpAgents: next })).then(
      reloadLocalHostStructuredAgents
    )
  }
  const editor = (current: CustomAcpAgentDraft): React.JSX.Element => (
    <CustomAcpAgentEditor
      draft={current}
      onChange={setDraft}
      onCancel={() => setDraft(null)}
      onSave={() => {
        save(saveCustomAcpAgentDraft(saved, current, randomSuffix))
        setDraft(null)
      }}
    />
  )
  return (
    <SettingsGroup
      title={t('settings.agents.customAcp.title', 'Custom ACP agents')}
      description={t(
        'settings.agents.customAcp.description',
        'Run any local command that speaks the Agent Client Protocol as a Chat agent. Orca starts it directly, without a shell.'
      )}
      action={
        draft ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDraft(emptyCustomAcpAgentDraft())}
          >
            <Plus />
            {t('settings.agents.customAcp.add', 'Local ACP command')}
          </Button>
        )
      }
    >
      {saved.length === 0 && !draft ? (
        <div data-settings-row="" className="py-3 text-xs text-muted-foreground">
          {t('settings.agents.customAcp.empty', 'No custom agents yet.')}
        </div>
      ) : null}
      {saved.map((agent) =>
        draft?.id === agent.id ? (
          <div key={agent.id}>{editor(draft)}</div>
        ) : (
          <CustomAcpAgentRow
            key={agent.id}
            agent={agent}
            disabled={draft !== null}
            onEdit={() => setDraft(customAcpAgentDraftFrom(agent))}
            onSetEnabled={(enabled) =>
              save(
                saved.map((existing) => {
                  if (existing.id !== agent.id) {
                    return existing
                  }
                  const { disabled: _disabled, ...rest } = existing
                  return enabled ? rest : { ...rest, disabled: true }
                })
              )
            }
            onRemove={() => save(saved.filter(({ id }) => id !== agent.id))}
          />
        )
      )}
      {draft && !draft.id ? editor(draft) : null}
    </SettingsGroup>
  )
}

function CustomAcpAgentRow({
  agent,
  disabled,
  onEdit,
  onSetEnabled,
  onRemove
}: {
  agent: CustomAcpAgent
  disabled: boolean
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const editLabel = t('settings.agents.customAcp.edit', 'Edit {{value0}}', { value0: agent.name })
  const removeLabel = t('settings.agents.customAcp.remove', 'Remove {{value0}}', {
    value0: agent.name
  })
  return (
    <div data-settings-row="" className="flex items-center gap-3 py-2.5">
      <div className={cn('min-w-0 flex-1', agent.disabled && 'opacity-40')}>
        <div className="truncate text-sm font-medium">{agent.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {customAcpAgentCommandLine(agent)}
        </div>
      </div>
      <Switch
        checked={!agent.disabled}
        disabled={disabled}
        onCheckedChange={onSetEnabled}
        aria-label={t('settings.agents.customAcp.availability', '{{value0}} availability', {
          value0: agent.name
        })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={editLabel}
        title={editLabel}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  )
}
function CustomAcpAgentEditor({
  draft,
  onChange,
  onCancel,
  onSave
}: {
  draft: CustomAcpAgentDraft
  onChange: (draft: CustomAcpAgentDraft) => void
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const problems = customAcpAgentDraftProblems(draft)
  // Errors show once a field has text, so an empty new form does not open in red.
  const nameInvalid = problems.has('name') && draft.name !== ''
  const commandInvalid = problems.has('command') && draft.command !== ''
  const idPrefix = draft.id ?? 'new-custom-acp-agent'
  const setArg = (key: number, value: string): void =>
    onChange({ ...draft, args: draft.args.map((row) => (row.key === key ? { key, value } : row)) })
  const setEnv = (entry: CustomAcpEnvRow): void =>
    onChange({ ...draft, env: draft.env.map((row) => (row.key === entry.key ? entry : row)) })
  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-name`}>
          {t('settings.agents.customAcp.name', 'Display name')}
        </Label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          aria-invalid={nameInvalid}
          placeholder={t('settings.agents.customAcp.namePlaceholder', 'My agent')}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-command`}>
          {t('settings.agents.customAcp.command', 'Command')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.agents.customAcp.commandDescription',
            'An executable path, or a program name on PATH.'
          )}
        </p>
        <Input
          id={`${idPrefix}-command`}
          variant="code"
          value={draft.command}
          aria-invalid={commandInvalid}
          placeholder={t('settings.agents.customAcp.commandPlaceholder', 'my-agent')}
          spellCheck={false}
          onChange={(event) => onChange({ ...draft, command: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label>{t('settings.agents.customAcp.args', 'Arguments')}</Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.agents.customAcp.argsDescription',
            'One argument per row, passed as written: no shell expansion or quoting.'
          )}
        </p>
        {draft.args.map((arg, index) => (
          <div key={arg.key} className="flex items-center gap-2">
            <Input
              variant="code"
              value={arg.value}
              spellCheck={false}
              aria-label={t('settings.agents.customAcp.argLabel', 'Argument {{value0}}', {
                value0: index + 1
              })}
              onChange={(event) => setArg(arg.key, event.target.value)}
            />
            <RemoveRowButton
              label={t('settings.agents.customAcp.removeArg', 'Remove argument {{value0}}', {
                value0: index + 1
              })}
              onClick={() =>
                onChange({ ...draft, args: draft.args.filter((row) => row.key !== arg.key) })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() =>
            onChange({ ...draft, args: [...draft.args, { key: draftRowKey(), value: '' }] })
          }
        >
          <Plus />
          {t('settings.agents.customAcp.addArg', 'Add argument')}
        </Button>
      </div>
      <div className="space-y-1">
        <Label>{t('settings.agents.customAcp.env', 'Environment variables')}</Label>
        {draft.env.map((entry, index) => (
          <div key={entry.key} className="flex items-center gap-2">
            <Input
              variant="code"
              className="w-2/5"
              value={entry.name}
              spellCheck={false}
              aria-invalid={entry.name.trim() !== '' && problems.has('envName')}
              placeholder={t('settings.agents.customAcp.envNamePlaceholder', 'NAME')}
              aria-label={t('settings.agents.customAcp.envName', 'Variable {{value0}} name', {
                value0: index + 1
              })}
              onChange={(event) => setEnv({ ...entry, name: event.target.value })}
            />
            <Input
              variant="code"
              value={entry.value}
              spellCheck={false}
              placeholder={t('settings.agents.customAcp.envValuePlaceholder', 'value')}
              aria-label={t('settings.agents.customAcp.envValue', 'Variable {{value0}} value', {
                value0: index + 1
              })}
              onChange={(event) => setEnv({ ...entry, value: event.target.value })}
            />
            <RemoveRowButton
              label={t('settings.agents.customAcp.removeEnv', 'Remove variable {{value0}}', {
                value0: index + 1
              })}
              onClick={() =>
                onChange({ ...draft, env: draft.env.filter((row) => row.key !== entry.key) })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() =>
            onChange({
              ...draft,
              env: [...draft.env, { key: draftRowKey(), name: '', value: '' }]
            })
          }
        >
          <Plus />
          {t('settings.agents.customAcp.addEnv', 'Add variable')}
        </Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('settings.agents.customAcp.cancel', 'Cancel')}
        </Button>
        <Button type="button" size="sm" disabled={problems.size > 0} onClick={onSave}>
          {t('settings.agents.customAcp.save', 'Save')}
        </Button>
      </div>
    </div>
  )
}

function RemoveRowButton({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <X />
    </Button>
  )
}
