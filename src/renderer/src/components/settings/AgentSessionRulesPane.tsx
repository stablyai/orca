import { useRef, useState } from 'react'
import type React from 'react'
import { Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import type {
  AgentSessionRule,
  AgentSessionRulesSettings
} from '../../../../shared/agent-session-rules-types'
import { normalizeAgentSessionRulesSettings } from '../../../../shared/agent-session-rules'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { getSettingOwnershipSummary } from './setting-ownership'
import { getAgentSessionRulesPaneSearchEntries } from './agent-session-rules-search'
import { AgentSessionRuleRow, ToggleSwitch } from './AgentSessionRuleRow'
import {
  clearAgentSessionRuleTextDraftIfUnchanged,
  composeDisplayAgentSessionRules,
  computeAgentSessionRuleDirtyById,
  mintCustomAgentSessionRuleId,
  patchAgentSessionRuleTextDraft,
  type AgentSessionRuleTextDraft
} from './agent-session-rules-draft'
import { translate } from '@/i18n/i18n'

type AgentSessionRulesPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

type AgentSessionRulesSettingsPatch =
  | Partial<AgentSessionRulesSettings>
  | ((current: AgentSessionRulesSettings) => Partial<AgentSessionRulesSettings>)

function readSettings(settings: GlobalSettings): AgentSessionRulesSettings {
  return normalizeAgentSessionRulesSettings(settings.agentSessionRules)
}

export function AgentSessionRulesPane({
  settings,
  updateSettings
}: AgentSessionRulesPaneProps): React.JSX.Element {
  const config = readSettings(settings)
  const ownership = getSettingOwnershipSummary('agentSessionRulesDefaults')
  const searchEntry = getAgentSessionRulesPaneSearchEntries()[0]
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [textDraftsById, setTextDraftsById] = useState<
    Partial<Record<string, AgentSessionRuleTextDraft>>
  >({})

  const writeConfig = (patch: AgentSessionRulesSettingsPatch): Promise<boolean> => {
    const write = settingsWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestSettings = useAppStore.getState().settings ?? settings
        const current = readSettings(latestSettings)
        const resolvedPatch = typeof patch === 'function' ? patch(current) : patch
        await updateSettings({
          agentSessionRules: {
            ...current,
            ...resolvedPatch
          }
        })
      })
    settingsWriteQueueRef.current = write.catch(() => undefined)
    return write.then(
      () => true,
      () => false
    )
  }

  const onToggleEnabled = (): void => {
    void writeConfig((current) => ({ enabled: !current.enabled }))
  }

  const onToggleRuleEnabled = (ruleId: string): void => {
    void writeConfig((current) => ({
      rules: current.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule
      )
    }))
  }

  const onDeleteRule = (ruleId: string): void => {
    const draft = textDraftsById[ruleId]
    void writeConfig((current) => ({
      rules: current.rules.filter((rule) => rule.id !== ruleId)
    })).then((saved) => {
      if (saved && draft) {
        setTextDraftsById((current) =>
          clearAgentSessionRuleTextDraftIfUnchanged(current, ruleId, draft)
        )
      }
    })
  }

  const onAddRule = (): void => {
    const rule: AgentSessionRule = {
      id: mintCustomAgentSessionRuleId(),
      label: translate('auto.components.settings.AgentSessionRulesPane.newRuleLabel', 'New rule'),
      content: '',
      enabled: true,
      source: 'custom'
    }
    void writeConfig((current) => ({ rules: [...current.rules, rule] }))
  }

  const onSaveRule = (rule: AgentSessionRule): void => {
    const draft = textDraftsById[rule.id]
    if (!draft) {
      return
    }
    void writeConfig((current) => ({
      rules: current.rules.map((r) =>
        r.id === rule.id ? { ...r, label: draft.label, content: draft.content } : r
      )
    })).then((saved) => {
      if (saved) {
        setTextDraftsById((current) =>
          clearAgentSessionRuleTextDraftIfUnchanged(current, rule.id, draft)
        )
      }
    })
  }

  const onDiscardRule = (ruleId: string): void => {
    setTextDraftsById((current) => {
      const { [ruleId]: _removed, ...rest } = current
      return rest
    })
  }

  const displayRules = composeDisplayAgentSessionRules(config.rules, textDraftsById)
  const dirtyByRuleId = computeAgentSessionRuleDirtyById(config.rules, textDraftsById)

  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="space-y-4 py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label>{searchEntry.title}</Label>
          <p className="text-xs text-muted-foreground">{ownership.description}</p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AgentSessionRulesPane.noSecrets',
              'Do not include secrets; some agents receive rules through startup command arguments.'
            )}
          </p>
        </div>
        <ToggleSwitch
          checked={config.enabled}
          onChange={onToggleEnabled}
          label={searchEntry.title}
        />
      </div>

      {config.enabled ? (
        <div className="space-y-2">
          {displayRules.map((rule) => (
            <AgentSessionRuleRow
              key={rule.id}
              rule={rule}
              dirty={Boolean(dirtyByRuleId[rule.id])}
              onLabelChange={(value) =>
                setTextDraftsById((current) =>
                  patchAgentSessionRuleTextDraft(current, rule, { label: value })
                )
              }
              onContentChange={(value) =>
                setTextDraftsById((current) =>
                  patchAgentSessionRuleTextDraft(current, rule, { content: value })
                )
              }
              onSave={() => onSaveRule(rule)}
              onDiscard={() => onDiscardRule(rule.id)}
              onToggleEnabled={() => onToggleRuleEnabled(rule.id)}
              onDelete={rule.source === 'custom' ? () => onDeleteRule(rule.id) : undefined}
            />
          ))}
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onAddRule}>
            <Plus className="size-3.5" />
            {translate('auto.components.settings.AgentSessionRulesPane.addRule', 'Add custom rule')}
          </Button>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
