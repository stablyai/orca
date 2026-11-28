// Settings > Agents: local ACP commands this machine runs as Chat agents.

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  CUSTOM_ACP_AGENT_LIMITS,
  normalizeCustomAcpAgents,
  savedCustomAcpDefaultAgent,
  type CustomAcpAgent,
  type CustomAcpAgentId
} from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { buildDefaultAgentSettingsUpdate } from '../../../../../../shared/agent-launch/choices/default-agent-settings'
import { CustomAcpAgentModelField } from './CustomAcpAgentModelField'
import { CustomAcpAgentPermissionField } from './CustomAcpAgentPermissionField'
import { CustomAcpAgentRow } from './CustomAcpAgentRow'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { reloadLocalHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents-sync'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  customAcpAgentDraftFrom,
  customAcpAgentDraftProblems,
  customAcpArgFits,
  customAcpDraftRowsFit,
  customAcpEnvValueFits,
  draftRowKey,
  emptyCustomAcpAgentDraft,
  saveCustomAcpAgentDraft,
  type CustomAcpAgentDraft,
  type CustomAcpEnvRow
} from './custom-acp-agent-draft'

type Props = {
  settings: GlobalSettings
}

const randomSuffix = (): string => createNonSecureContextUuid().replace(/-/g, '')

export function CustomAcpAgentsSetting({ settings }: Props): React.JSX.Element {
  const t = useTranslate()
  // The throwing write: the store's updateSettings logs a failed save and resolves, which would
  // close the editor on a draft that was never saved.
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const saved = normalizeCustomAcpAgents(settings.customAcpAgents)
  const [draft, setDraft] = useState<CustomAcpAgentDraft | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle')
  const defaultId = savedCustomAcpDefaultAgent(settings)?.id ?? null
  // Settings keep only the first CUSTOM_ACP_AGENT_LIMITS.agents rows, so none is added past them.
  const atLimit = saved.length >= CUSTOM_ACP_AGENT_LIMITS.agents
  /** Resolves false when the settings could not be saved. */
  const save = async (next: CustomAcpAgent[]): Promise<boolean> => {
    // A removed default would otherwise come back if an agent with its id were added again.
    const keepsDefault = next.some(({ id }) => id === settings.defaultCustomAcpAgent)
    try {
      await updateSettings({
        customAcpAgents: next,
        ...(settings.defaultCustomAcpAgent && !keepsDefault ? { defaultCustomAcpAgent: null } : {})
      })
    } catch (error) {
      console.error('Failed to save custom ACP agents:', error)
      return false
    }
    // New chats list this machine's agents from its runtime, which reads the saved settings.
    void reloadLocalHostStructuredAgents()
    return true
  }
  const openDraft = (next: CustomAcpAgentDraft | null): void => {
    setSaveState('idle')
    setDraft(next)
  }
  const setDefault = (id: CustomAcpAgentId | null): void => {
    // Built-in choices clear this one; this clears the built-in default, so one agent is the default.
    void updateSettings({
      ...buildDefaultAgentSettingsUpdate(null),
      defaultCustomAcpAgent: id
    }).catch((error: unknown) => console.error('Failed to set the default agent:', error))
  }
  const editor = (current: CustomAcpAgentDraft): React.JSX.Element => (
    <CustomAcpAgentEditor
      draft={current}
      saveState={saveState}
      onChange={setDraft}
      onCancel={() => openDraft(null)}
      onSave={() => {
        setSaveState('saving')
        // The draft stays open until the settings hold it, so a failed save can be retried.
        void save(saveCustomAcpAgentDraft(saved, current, randomSuffix)).then((ok) =>
          ok ? openDraft(null) : setSaveState('failed')
        )
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
            disabled={atLimit}
            onClick={() => openDraft(emptyCustomAcpAgentDraft())}
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
            isDefault={agent.id === defaultId}
            onSetDefault={(isDefault) => setDefault(isDefault ? agent.id : null)}
            onEdit={() => openDraft(customAcpAgentDraftFrom(agent))}
            onSetEnabled={(enabled) =>
              void save(
                saved.map((existing) => {
                  if (existing.id !== agent.id) {
                    return existing
                  }
                  const { disabled: _disabled, ...rest } = existing
                  return enabled ? rest : { ...rest, disabled: true }
                })
              )
            }
            onRemove={() => void save(saved.filter(({ id }) => id !== agent.id))}
          />
        )
      )}
      {draft && !draft.id ? editor(draft) : null}
      {atLimit && !draft ? (
        <div data-settings-row="" className="py-3 text-xs text-muted-foreground">
          {t(
            'settings.agents.customAcp.limit',
            'Orca keeps up to {{limit}} custom agents. Remove one to add another.',
            { limit: CUSTOM_ACP_AGENT_LIMITS.agents }
          )}
        </div>
      ) : null}
    </SettingsGroup>
  )
}

function CustomAcpAgentEditor({
  draft,
  saveState,
  onChange,
  onCancel,
  onSave
}: {
  draft: CustomAcpAgentDraft
  saveState: 'idle' | 'saving' | 'failed'
  onChange: (draft: CustomAcpAgentDraft) => void
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const problems = customAcpAgentDraftProblems(draft)
  // Errors show once a field has text, so an empty new form does not open in red.
  const nameInvalid = problems.has('name') && draft.name !== ''
  const commandInvalid = problems.has('command') && draft.command !== ''
  const rowsFit = customAcpDraftRowsFit(draft)
  const idPrefix = draft.id ?? 'new-custom-acp-agent'
  const setArg = (key: number, value: string): void =>
    onChange({ ...draft, args: draft.args.map((row) => (row.key === key ? { key, value } : row)) })
  const setEnv = (entry: CustomAcpEnvRow): void =>
    onChange({ ...draft, env: draft.env.map((row) => (row.key === entry.key ? entry : row)) })
  return (
    <div data-settings-row="" className="py-3">
      {/* A pending save holds this draft as it was, so nothing in it changes until it settles. */}
      <fieldset disabled={saveState === 'saving'} className="min-w-0 space-y-3">
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
        <CustomAcpAgentModelField
          agent={draft.id}
          value={draft.defaultModel}
          invalid={
            problems.has('tooLong') &&
            draft.defaultModel.trim().length > CUSTOM_ACP_AGENT_LIMITS.model
          }
          onChange={(defaultModel) => onChange({ ...draft, defaultModel })}
          idPrefix={idPrefix}
        />
        <CustomAcpAgentPermissionField
          value={draft.newChatPermission}
          onChange={(newChatPermission) => onChange({ ...draft, newChatPermission })}
          idPrefix={idPrefix}
        />
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
                aria-invalid={!customAcpArgFits(arg.value)}
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
            disabled={!rowsFit.args}
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
                aria-invalid={!customAcpEnvValueFits(entry.value)}
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
            disabled={!rowsFit.env}
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
        <div className="flex items-center justify-end gap-2">
          {saveState === 'failed' ? (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {t(
                'settings.agents.customAcp.saveFailed',
                "Orca couldn't save the agent. Try again."
              )}
            </p>
          ) : problems.has('tooLong') ? (
            <p className="mr-auto text-xs text-destructive">
              {t('settings.agents.customAcp.tooLong', 'A highlighted value is too long to save.')}
            </p>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('settings.agents.customAcp.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={problems.size > 0 || saveState === 'saving'}
            onClick={onSave}
          >
            {t('settings.agents.customAcp.save', 'Save')}
          </Button>
        </div>
      </fieldset>
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
