import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  setSourceControlActionDefault,
  type GlobalOnlyAiTextActionId
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { CUSTOM_AGENT_ID } from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { replayGlobalTextModelEdits } from './text-actions/source-control-text-action-model-replay'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'

/** Draft, save, and dirty tracking for a recipe card that only global settings own. */
export function useGlobalTextActionRecipeDraft({
  actionId,
  settings,
  writeSourceControlAiSettings,
  onDirtyChange,
  onSaveError
}: {
  actionId: GlobalOnlyAiTextActionId
  settings: GlobalSettings
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onSaveError: (error: unknown) => void
}) {
  const config = useMemo(
    () => normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi),
    [settings.sourceControlAi, settings.commitMessageAi]
  )
  const recipe = config.actions?.[actionId]
  const persistedModelChoice = config.modelOverridesByOperation?.[actionId]
  const persisted = useMemo<ActionRecipeDraftValue>(
    () => ({
      commandInputTemplate:
        recipe?.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId],
      agentArgs: recipe?.agentArgs ?? '',
      modelChoice: persistedModelChoice
    }),
    [actionId, recipe, persistedModelChoice]
  )
  const [draft, setDraft] = useState<ActionRecipeDraftValue | null>(null)
  const [customCommandDraft, setCustomCommandDraft] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  // Without a menu edit the model choice is whatever is saved now, including another editor's.
  const value = useMemo(
    () =>
      draft && !draft.modelEdits?.length
        ? { ...draft, modelChoice: persisted.modelChoice }
        : (draft ?? persisted),
    [draft, persisted]
  )
  const customCommand = customCommandDraft ?? config.customAgentCommand
  const customCommandDirty = customCommand !== config.customAgentCommand
  const recipeDirty = JSON.stringify(value) !== JSON.stringify(persisted)
  const latestValueRef = useRef({ value, customCommand, customCommandDraft })
  const dirty = recipeDirty || customCommandDirty
  const onDirtyChangeRef = useRef(onDirtyChange)
  useLayoutEffect(() => {
    latestValueRef.current = { value, customCommand, customCommandDraft }
    onDirtyChangeRef.current = onDirtyChange
  }, [value, customCommand, customCommandDraft, onDirtyChange])
  const isMountedRef = useRef(false)
  const clearDirtyOnUnmount = useCallback((node: HTMLSpanElement | null): void => {
    isMountedRef.current = node !== null
    if (node === null) {
      onDirtyChangeRef.current?.(false)
    }
  }, [])

  const updateDraft = (next: ActionRecipeDraftValue): void => {
    latestValueRef.current = { value: next, customCommand, customCommandDraft }
    setDraft(next)
    onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(persisted) || customCommandDirty)
  }

  const updateCustomCommandDraft = (next: string): void => {
    const changed = next !== config.customAgentCommand
    latestValueRef.current = { value, customCommand: next, customCommandDraft: next }
    setCustomCommandDraft(next)
    onDirtyChange?.(recipeDirty || changed)
  }

  const discard = (): void => {
    setDraft(null)
    setCustomCommandDraft(null)
    onDirtyChange?.(false)
  }

  const save = async (): Promise<void> => {
    if (!dirty || isSaving) {
      return
    }
    setIsSaving(true)
    try {
      await writeSourceControlAiSettings((current) => ({
        actions: setSourceControlActionDefault(current.actions, actionId, {
          commandInputTemplate: value.commandInputTemplate,
          agentArgs: value.agentArgs
        }),
        ...(value.modelEdits?.length
          ? {
              modelOverridesByOperation: {
                ...current.modelOverridesByOperation,
                [actionId]: replayGlobalTextModelEdits(current, actionId, value.modelEdits)
              }
            }
          : {}),
        ...(customCommandDirty ? { customAgentCommand: customCommand } : {})
      }))
      if (!isMountedRef.current) {
        return
      }
      const latestValue = latestValueRef.current
      const hasNewEdits = JSON.stringify(latestValue.value) !== JSON.stringify(value)
      const hasNewCommandEdits =
        latestValue.customCommandDraft !== null && latestValue.customCommand !== customCommand
      setDraft(hasNewEdits ? latestValue.value : null)
      setCustomCommandDraft(hasNewCommandEdits ? latestValue.customCommand : null)
      onDirtyChangeRef.current?.(hasNewEdits || hasNewCommandEdits)
    } catch (error) {
      onSaveError(error)
    } finally {
      setIsSaving(false)
    }
  }

  const saveAgent = async (selected: string): Promise<void> => {
    const agentId =
      selected === '__default_agent__'
        ? null
        : selected === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : isTuiAgent(selected)
            ? selected
            : null
    try {
      await writeSourceControlAiSettings((current) => ({
        actions: setSourceControlActionDefault(current.actions, actionId, { agentId })
      }))
    } catch (error) {
      onSaveError(error)
    }
  }

  const appendVariable = (variable: string): void => {
    const template = value.commandInputTemplate
    const separator = template.endsWith('\n') || template.length === 0 ? '' : ' '
    updateDraft({ ...value, commandInputTemplate: `${template}${separator}{${variable}}` })
  }

  return {
    config,
    recipe,
    persisted,
    value,
    dirty,
    customCommand,
    customCommandDirty,
    isSaving,
    clearDirtyOnUnmount,
    updateDraft,
    updateCustomCommandDraft,
    discard,
    save,
    saveAgent,
    appendVariable
  }
}
