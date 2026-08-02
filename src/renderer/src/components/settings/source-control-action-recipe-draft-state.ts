import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import {
  setSourceControlActionDefault,
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

  return {
    actionRecipeDraftState,
    savingActionTemplateIds,
    onActionTemplateChange,
    onActionAgentArgsChange,
    saveActionTemplateDraft,
    discardActionTemplateDraft,
    appendVariable
  }
}
