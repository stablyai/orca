import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Terminal } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import { CUSTOM_AGENT_ID, isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_ACTION_LABELS,
  setSourceControlActionDefault,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import type { ActionRecipeDraftState } from './source-control-ai-action-recipe-draft'
import {
  readActionRecipeInputValues,
  serializeActionRecipeInputValues
} from './source-control-ai-action-recipe-draft'
import {
  ACTION_DESCRIPTIONS,
  SOURCE_CONTROL_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'

type SourceControlAiActionRecipeDefaultsProps = {
  config: SourceControlAiSettings
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  customPromptDiscardSignal?: number
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  searchQuery: string
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

const DEFAULT_AGENT_VALUE = '__default_agent__'

function resolveAgentArgsPlaceholderAgent(
  selectedAgent: TuiAgent | CustomAgentId | null | undefined,
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
): TuiAgent | null {
  if (selectedAgent && !isCustomAgentId(selectedAgent)) {
    return selectedAgent
  }
  return defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null
}

export function SourceControlAiActionRecipeDefaults({
  config,
  defaultTuiAgent,
  customPromptDiscardSignal,
  onCustomPromptDirtyChange,
  searchQuery,
  writeConfig
}: SourceControlAiActionRecipeDefaultsProps): React.JSX.Element | null {
  const persistedActionRecipeValues = useMemo(() => readActionRecipeInputValues(config), [config])
  const persistedActionRecipeSerialized = useMemo(
    () => serializeActionRecipeInputValues(persistedActionRecipeValues),
    [persistedActionRecipeValues]
  )
  const persistedActionRecipeValuesRef = useRef(persistedActionRecipeValues)
  persistedActionRecipeValuesRef.current = persistedActionRecipeValues
  const [actionRecipeDraftState, setActionRecipeDraftState] = useState<ActionRecipeDraftState>(
    () => ({
      values: persistedActionRecipeValues,
      baseValues: persistedActionRecipeValues
    })
  )
  const [savingActionTemplateIds, setSavingActionTemplateIds] = useState<
    Partial<Record<SourceControlActionId, boolean>>
  >({})
  const actionRecipeDraftSerialized = useMemo(
    () => serializeActionRecipeInputValues(actionRecipeDraftState.values),
    [actionRecipeDraftState.values]
  )
  const actionRecipeBaseSerialized = useMemo(
    () => serializeActionRecipeInputValues(actionRecipeDraftState.baseValues),
    [actionRecipeDraftState.baseValues]
  )
  const actionTemplateDirty = actionRecipeDraftSerialized !== actionRecipeBaseSerialized

  useEffect(() => {
    setActionRecipeDraftState((current) => {
      const currentSerialized = serializeActionRecipeInputValues(current.values)
      const baseSerialized = serializeActionRecipeInputValues(current.baseValues)
      if (
        currentSerialized === baseSerialized ||
        currentSerialized === persistedActionRecipeSerialized
      ) {
        return {
          values: persistedActionRecipeValues,
          baseValues: persistedActionRecipeValues
        }
      }
      return {
        values: current.values,
        baseValues: persistedActionRecipeValues
      }
    })
  }, [persistedActionRecipeSerialized, persistedActionRecipeValues])

  useEffect(() => {
    setActionRecipeDraftState({
      values: persistedActionRecipeValuesRef.current,
      baseValues: persistedActionRecipeValuesRef.current
    })
  }, [customPromptDiscardSignal])

  useEffect(() => {
    onCustomPromptDirtyChange?.(actionTemplateDirty)
  }, [actionTemplateDirty, onCustomPromptDirtyChange])

  useEffect(
    () => () => {
      onCustomPromptDirtyChange?.(false)
    },
    [onCustomPromptDirtyChange]
  )

  const onActionAgentChange = async (
    actionId: SourceControlActionId,
    value: string
  ): Promise<void> => {
    const agentId =
      value === DEFAULT_AGENT_VALUE
        ? null
        : value === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : (value as TuiAgent)
    let previousActions = config.actions
    try {
      await writeConfig((current) => {
        previousActions = current.actions
        return {
          actions: setSourceControlActionDefault(current.actions, actionId, { agentId })
        }
      })
    } catch (error) {
      console.error('Failed to save Source Control AI action agent default', error)
      try {
        await writeConfig({ actions: previousActions })
      } catch (rollbackError) {
        console.error('Failed to roll back Source Control AI action agent default', rollbackError)
      }
      toast.error(
        `Failed to save Source Control AI action default: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    }
  }

  const onActionTemplateChange = (actionId: SourceControlActionId, value: string): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: {
          ...current.values[actionId],
          commandInputTemplate: value
        }
      }
    }))
  }

  const onActionAgentArgsChange = (actionId: SourceControlActionId, value: string): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: {
          ...current.values[actionId],
          agentArgs: value
        }
      }
    }))
  }

  const saveActionTemplateDraft = async (actionId: SourceControlActionId): Promise<void> => {
    const nextValue = actionRecipeDraftState.values[actionId]
    if (
      JSON.stringify(nextValue) === JSON.stringify(actionRecipeDraftState.baseValues[actionId]) ||
      savingActionTemplateIds[actionId]
    ) {
      return
    }
    setSavingActionTemplateIds((current) => ({ ...current, [actionId]: true }))
    try {
      await writeConfig((current) => {
        return {
          actions: setSourceControlActionDefault(current.actions, actionId, {
            commandInputTemplate: nextValue.commandInputTemplate,
            agentArgs: nextValue.agentArgs
          })
        }
      })
      setActionRecipeDraftState((current) => ({
        values: current.values,
        baseValues: {
          ...current.baseValues,
          [actionId]: nextValue
        }
      }))
    } finally {
      setSavingActionTemplateIds((current) => ({ ...current, [actionId]: false }))
    }
  }

  const discardActionTemplateDraft = (actionId: SourceControlActionId): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: current.baseValues[actionId]
      }
    }))
  }

  const appendVariable = (actionId: SourceControlActionId, variable: string): void => {
    setActionRecipeDraftState((current) => {
      const currentTemplate = current.values[actionId].commandInputTemplate
      const separator = currentTemplate.endsWith('\n') || currentTemplate.length === 0 ? '' : ' '
      return {
        ...current,
        values: {
          ...current.values,
          [actionId]: {
            ...current.values[actionId],
            commandInputTemplate: `${currentTemplate}${separator}{${variable}}`
          }
        }
      }
    })
  }

  if (
    !config.enabled ||
    !matchesSettingsSearch(searchQuery, {
      title: 'Action recipes',
      description:
        'Agent, CLI arguments, and command template used by each Source Control AI button.',
      keywords: [
        'agent',
        'arguments',
        'args',
        'cli',
        'command',
        'model',
        'template',
        'fix',
        'checks',
        'commit',
        'pull request'
      ]
    })
  ) {
    return null
  }

  return (
    <SearchableSetting
      title="Action recipes"
      description="Agent, CLI arguments, and command template used by each Source Control AI button."
      keywords={[
        'agent',
        'arguments',
        'args',
        'cli',
        'command',
        'model',
        'template',
        'fix',
        'checks',
        'commit',
        'pull request'
      ]}
      className="space-y-3 px-1 py-2"
    >
      <div className="space-y-0.5">
        <Label>Action recipes</Label>
        <p className="text-xs text-muted-foreground">
          Use variables only when you want Orca to inject context. Leave the agent as default to
          follow your normal agent preference.
        </p>
      </div>
      <div className="space-y-3">
        {SOURCE_CONTROL_ACTION_IDS.map((actionId) => {
          const recipe = config.actions?.[actionId]
          const selectedAgent = recipe?.agentId ?? null
          const draftValue = actionRecipeDraftState.values[actionId]
          const template = draftValue.commandInputTemplate
          const agentArgs = draftValue.agentArgs
          const agentArgsPlaceholder = getSourceControlAgentArgsPlaceholder(
            resolveAgentArgsPlaceholderAgent(selectedAgent, defaultTuiAgent)
          )
          const templateDirty =
            JSON.stringify(draftValue) !==
            JSON.stringify(actionRecipeDraftState.baseValues[actionId])
          const isSavingTemplate = savingActionTemplateIds[actionId] === true
          const agentOptions = getAgentCatalogForAction(actionId, selectedAgent)
          return (
            <div key={actionId} className="rounded-md border border-border px-3 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-medium text-foreground">
                    {SOURCE_CONTROL_ACTION_LABELS[actionId]}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {ACTION_DESCRIPTIONS[actionId]}
                  </p>
                </div>
                <Select
                  value={selectedAgent ?? DEFAULT_AGENT_VALUE}
                  onValueChange={(value) => void onActionAgentChange(actionId, value)}
                >
                  <SelectTrigger size="sm" className="h-8 w-full shrink-0 text-xs sm:w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_AGENT_VALUE}>
                      <span className="flex items-center gap-2">
                        <Terminal className="size-3.5 text-muted-foreground" />
                        Use default agent
                      </span>
                    </SelectItem>
                    {SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId) ? (
                      <SelectItem value={CUSTOM_AGENT_ID}>
                        <span className="flex items-center gap-2">
                          <Terminal className="size-3.5 text-muted-foreground" />
                          Custom command
                        </span>
                      </SelectItem>
                    ) : null}
                    {agentOptions.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex items-center gap-2">
                          <AgentIcon agent={agent.id} size={14} />
                          {agent.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">CLI arguments</Label>
                  <Input
                    value={agentArgs}
                    spellCheck={false}
                    placeholder={agentArgsPlaceholder}
                    onChange={(event) => onActionAgentArgsChange(actionId, event.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">Command template</Label>
                  <textarea
                    value={template}
                    rows={3}
                    spellCheck={false}
                    onChange={(event) => onActionTemplateChange(actionId, event.target.value)}
                    className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <SourceControlActionVariableChips
                    actionId={actionId}
                    onInsert={(variable) => appendVariable(actionId, variable)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  {templateDirty ? 'Unsaved changes' : 'Saved'}
                </p>
                <div className="flex items-center gap-2">
                  {templateDirty ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => discardActionTemplateDraft(actionId)}
                      disabled={isSavingTemplate}
                    >
                      Discard
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => void saveActionTemplateDraft(actionId)}
                    disabled={!templateDirty || isSavingTemplate}
                  >
                    {isSavingTemplate ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </SearchableSetting>
  )
}
