import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import { useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import {
  setSourceControlActionDefault,
  type SourceControlActionLaunchPreferences,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import type { ActionRecipeDraftState } from './source-control-ai-action-recipe-draft'
import {
  readActionRecipeInputValues,
  serializeActionRecipeInputValues
} from './source-control-ai-action-recipe-draft'

type UseSourceControlActionRecipeDraftStateArgs = {
  config: SourceControlAiSettings
  customPromptDiscardSignal?: number
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

export function useSourceControlActionRecipeDraftState({
  config,
  customPromptDiscardSignal,
  onCustomPromptDirtyChange,
  writeConfig
}: UseSourceControlActionRecipeDraftStateArgs) {
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

  const onActionAgentArgsChange = (
    actionId: SourceControlActionId,
    value: string,
    commit = false
  ): void => {
    setActionRecipeDraftState((current) => {
      const { agentId: _binding, ...valueDraft } = commit
        ? liftActionPermissionArgs(
            {
              ...current.values[actionId],
              agentId: config.actions?.[actionId]?.agentId,
              agentArgs: value
            },
            true,
            actionId
          )
        : {
            ...current.values[actionId],
            agentId: config.actions?.[actionId]?.agentId,
            agentArgs: value
          }
      return { ...current, values: { ...current.values, [actionId]: valueDraft } }
    })
  }

  const onActionLaunchPreferencesChange = (
    actionId: SourceControlActionId,
    update: SetStateAction<SourceControlActionLaunchPreferences | undefined>
  ): void => {
    setActionRecipeDraftState((current) => {
      const latest = current.values[actionId].launchPreferences
      const next = typeof update === 'function' ? update(latest) : update
      // A completion with no owned change must not materialize an explicit clear.
      if (typeof update === 'function' && next === latest) {
        return current
      }
      return {
        ...current,
        values: {
          ...current.values,
          [actionId]: { ...current.values[actionId], launchPreferences: next }
        }
      }
    })
  }

  const saveActionTemplateDraft = async (actionId: SourceControlActionId): Promise<void> => {
    const submitted = actionRecipeDraftState.values[actionId]
    const { agentId: _binding, ...nextValue } = liftActionPermissionArgs(
      { ...actionRecipeDraftState.values[actionId], agentId: config.actions?.[actionId]?.agentId },
      true,
      actionId
    )
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
            agentArgs: nextValue.agentArgs,
            launchPreferences: nextValue.launchPreferences
          })
        }
      })
      setActionRecipeDraftState((current) => ({
        values:
          JSON.stringify(current.values[actionId]) === JSON.stringify(submitted)
            ? { ...current.values, [actionId]: nextValue }
            : current.values,
        baseValues: { ...current.baseValues, [actionId]: nextValue }
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

  return {
    actionRecipeDraftState,
    savingActionTemplateIds,
    onActionTemplateChange,
    onActionAgentArgsChange,
    onActionLaunchPreferencesChange,
    saveActionTemplateDraft,
    discardActionTemplateDraft,
    appendVariable
  }
}
