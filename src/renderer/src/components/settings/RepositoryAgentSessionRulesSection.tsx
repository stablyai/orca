import { useState } from 'react'
import type React from 'react'
import { Plus } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import type {
  AgentSessionRule,
  RepoAgentSessionRuleOverrides
} from '../../../../shared/agent-session-rules-types'
import {
  normalizeAgentSessionRulesSettings,
  normalizeRepoAgentSessionRuleOverrides
} from '../../../../shared/agent-session-rules'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getRepositoryAgentSessionRulesSectionId } from './repository-settings-targets'
import { getSettingOwnershipSummary } from './setting-ownership'
import { AgentSessionRuleRow } from './AgentSessionRuleRow'
import {
  clearAgentSessionRuleTextDraftIfUnchanged,
  composeDisplayAgentSessionRules,
  computeAgentSessionRuleDirtyById,
  mintCustomAgentSessionRuleId,
  patchAgentSessionRuleTextDraft,
  type AgentSessionRuleTextDraft
} from './agent-session-rules-draft'
import { translate } from '@/i18n/i18n'
import { useRepositoryAgentSessionRulesWriter } from './repository-agent-session-rules-writer'

type RepositoryAgentSessionRulesSectionProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { agentSessionRules?: RepoAgentSessionRuleOverrides | null }
  ) => void | Promise<boolean>
}

function tristate(value: boolean | null | undefined): 'inherit' | 'on' | 'off' {
  if (value === true) {
    return 'on'
  }
  if (value === false) {
    return 'off'
  }
  return 'inherit'
}

export function RepositoryAgentSessionRulesSection({
  repo,
  updateRepo
}: RepositoryAgentSessionRulesSectionProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const ownership = getSettingOwnershipSummary('repositoryAgentSessionRules')
  const globalConfig = normalizeAgentSessionRulesSettings(settings?.agentSessionRules)
  const overrides: RepoAgentSessionRuleOverrides =
    normalizeRepoAgentSessionRuleOverrides(repo.agentSessionRules) ?? {}
  const disabledRuleIds = new Set(overrides.disabledRuleIds ?? [])
  const extraRules = overrides.extraRules ?? []
  const writeOverrides = useRepositoryAgentSessionRulesWriter({ repo, updateRepo })
  const [extraTextDraftsById, setExtraTextDraftsById] = useState<
    Partial<Record<string, AgentSessionRuleTextDraft>>
  >({})

  const onEnabledChange = (value: 'inherit' | 'on' | 'off'): void => {
    void writeOverrides({ enabled: value === 'inherit' ? undefined : value === 'on' })
  }

  const onToggleGlobalRuleDisabled = (ruleId: string, disabled: boolean): void => {
    void writeOverrides((current) => {
      const next = new Set(current.disabledRuleIds ?? [])
      if (disabled) {
        next.add(ruleId)
      } else {
        next.delete(ruleId)
      }
      return { disabledRuleIds: next.size > 0 ? Array.from(next) : undefined }
    })
  }

  const onToggleExtraRuleEnabled = (ruleId: string): void => {
    void writeOverrides((current) => ({
      extraRules: (current.extraRules ?? []).map((rule) =>
        rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule
      )
    }))
  }

  const onDeleteExtraRule = (ruleId: string): void => {
    const draft = extraTextDraftsById[ruleId]
    void writeOverrides((current) => ({
      extraRules: (current.extraRules ?? []).filter((rule) => rule.id !== ruleId)
    })).then((saved) => {
      if (saved && draft) {
        setExtraTextDraftsById((current) =>
          clearAgentSessionRuleTextDraftIfUnchanged(current, ruleId, draft)
        )
      }
    })
  }

  const onAddExtraRule = (): void => {
    const rule: AgentSessionRule = {
      id: mintCustomAgentSessionRuleId(),
      label: translate(
        'auto.components.settings.RepositoryAgentSessionRulesSection.newRuleLabel',
        'New rule'
      ),
      content: '',
      enabled: true,
      source: 'custom'
    }
    void writeOverrides((current) => ({ extraRules: [...(current.extraRules ?? []), rule] }))
  }

  const onSaveExtraRule = (rule: AgentSessionRule): void => {
    const draft = extraTextDraftsById[rule.id]
    if (!draft) {
      return
    }
    void writeOverrides((current) => ({
      extraRules: (current.extraRules ?? []).map((r) =>
        r.id === rule.id ? { ...r, label: draft.label, content: draft.content } : r
      )
    })).then((saved) => {
      if (saved) {
        setExtraTextDraftsById((current) =>
          clearAgentSessionRuleTextDraftIfUnchanged(current, rule.id, draft)
        )
      }
    })
  }

  const onDiscardExtraRule = (ruleId: string): void => {
    setExtraTextDraftsById((current) => {
      const { [ruleId]: _removed, ...rest } = current
      return rest
    })
  }

  const displayExtraRules = composeDisplayAgentSessionRules(extraRules, extraTextDraftsById)
  const extraDirtyByRuleId = computeAgentSessionRuleDirtyById(extraRules, extraTextDraftsById)

  return (
    <section
      id={getRepositoryAgentSessionRulesSectionId(repo.id)}
      data-settings-section={getRepositoryAgentSessionRulesSectionId(repo.id)}
      className="space-y-4"
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryAgentSessionRulesSection.title',
            'Agent Session Rules'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">{ownership.description}</p>
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">
            {translate(
              'auto.components.settings.RepositoryAgentSessionRulesSection.enabledLabel',
              'Inject rules into sessions'
            )}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryAgentSessionRulesSection.enabledHelper',
              'Global default is {{value0}}.',
              {
                value0: globalConfig.enabled
                  ? translate(
                      'auto.components.settings.RepositoryAgentSessionRulesSection.on',
                      'On'
                    )
                  : translate(
                      'auto.components.settings.RepositoryAgentSessionRulesSection.off',
                      'Off'
                    )
              }
            )}
          </p>
        </div>
        <Select
          value={tristate(overrides.enabled)}
          onValueChange={(value) => onEnabledChange(value as 'inherit' | 'on' | 'off')}
        >
          <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              {translate(
                'auto.components.settings.RepositoryAgentSessionRulesSection.useGlobal',
                'Use global'
              )}
            </SelectItem>
            <SelectItem value="on">
              {translate('auto.components.settings.RepositoryAgentSessionRulesSection.on', 'On')}
            </SelectItem>
            <SelectItem value="off">
              {translate('auto.components.settings.RepositoryAgentSessionRulesSection.off', 'Off')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {globalConfig.rules.length > 0 ? (
        <div className="space-y-2">
          <Label className="text-xs font-medium">
            {translate(
              'auto.components.settings.RepositoryAgentSessionRulesSection.globalRulesLabel',
              'Global rules applied here'
            )}
          </Label>
          <div className="space-y-1 rounded-md border border-border/60 bg-card/30 p-2">
            {globalConfig.rules.map((rule) => (
              <label key={rule.id} className="flex items-center gap-2 px-1 py-1 text-xs">
                <Checkbox
                  checked={!disabledRuleIds.has(rule.id)}
                  onCheckedChange={(checked) =>
                    onToggleGlobalRuleDisabled(rule.id, checked !== true)
                  }
                />
                <span className="min-w-0 flex-1 truncate">{rule.label}</span>
                {!rule.enabled ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {translate(
                      'auto.components.settings.RepositoryAgentSessionRulesSection.disabledGlobally',
                      'disabled globally'
                    )}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label className="text-xs font-medium">
          {translate(
            'auto.components.settings.RepositoryAgentSessionRulesSection.extraRulesLabel',
            'Rules only for this project'
          )}
        </Label>
        {displayExtraRules.map((rule) => (
          <AgentSessionRuleRow
            key={rule.id}
            rule={rule}
            dirty={Boolean(extraDirtyByRuleId[rule.id])}
            onLabelChange={(value) =>
              setExtraTextDraftsById((current) =>
                patchAgentSessionRuleTextDraft(current, rule, { label: value })
              )
            }
            onContentChange={(value) =>
              setExtraTextDraftsById((current) =>
                patchAgentSessionRuleTextDraft(current, rule, { content: value })
              )
            }
            onSave={() => onSaveExtraRule(rule)}
            onDiscard={() => onDiscardExtraRule(rule.id)}
            onToggleEnabled={() => onToggleExtraRuleEnabled(rule.id)}
            onDelete={() => onDeleteExtraRule(rule.id)}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onAddExtraRule}
        >
          <Plus className="size-3.5" />
          {translate(
            'auto.components.settings.RepositoryAgentSessionRulesSection.addExtraRule',
            'Add project-only rule'
          )}
        </Button>
      </div>
    </section>
  )
}
