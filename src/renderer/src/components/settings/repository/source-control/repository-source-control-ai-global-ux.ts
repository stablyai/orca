import { liftActionPermissionArgs } from '../../../../../../shared/source-control-action-permission-lift'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { CUSTOM_AGENT_ID } from '../../../../../../shared/commit-message-agent-spec'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../../../shared/source-control-ai-types'
import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control-ai-recipe-save'
import type {
  SourceControlActionRecipe,
  SourceControlActionId
} from '../../../../../../shared/source-control-ai-actions'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  clearActionTextDraftIfUnchanged,
  composeDisplayRepoAi,
  computeActionDirtyById,
  hasOwnActionOverride,
  readCompleteRecipeForDraft,
  readActionRecipeTextDraft,
  type ActionRecipeTextDraft,
  retainCustomCommandDraft,
  retainDivergentActionTextDrafts,
  withRepoAiActionMode,
  withRepoAiActionRecipeText,
  withRepoAiCustomCommand,
  withRepoAiEnabled,
  withRepoAiHostedReviewDefault
} from './repository-source-control-ai-draft'
import { ACTION_MODE_INHERIT, DEFAULT_AGENT_VALUE } from './repository-source-control-ai-labels'
import { createRepoAiPersistQueue } from './repository-source-control-ai-persist-queue'
import { withRepoAiActionAgent } from '../../repository-source-control-ai-action-agent-draft'
import {
  createRepoActionTextDraftEditors,
  resetActionDraftLaunchPreferences
} from '../../repository-source-control-ai-text-draft'

type HostedReviewDefaultKey = keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>

type UseRepositorySourceControlAiGlobalUxArgs = {
  repoId: string
  persistedRepoAi: RepoSourceControlAiOverrides
  settings: GlobalSettings | null
  source: SourceControlAiSettings
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
}

/** Simple controls save immediately; arguments and templates stay drafts until Save. */
export function useRepositorySourceControlAiGlobalUx({
  repoId,
  persistedRepoAi,
  settings,
  source,
  updateRepo
}: UseRepositorySourceControlAiGlobalUxArgs) {
  const mountedRef = useMountedRef()
  const persistedSerialized = useMemo(() => JSON.stringify(persistedRepoAi), [persistedRepoAi])
  const persistedRef = useRef(persistedRepoAi)
  const repoIdRef = useRef(repoId)
  const updateRepoRef = useRef(updateRepo)
  repoIdRef.current = repoId
  updateRepoRef.current = updateRepo

  const [saveError, setSaveError] = useState<string | null>(null)
  const [immediateRepoAi, setImmediateRepoAi] = useState(persistedRepoAi)
  const immediateRepoAiRef = useRef(immediateRepoAi)
  immediateRepoAiRef.current = immediateRepoAi
  const [baselineRepoAi, setBaselineRepoAi] = useState(persistedRepoAi)
  const setBaselineRepoAiRef = useRef(setBaselineRepoAi)
  setBaselineRepoAiRef.current = setBaselineRepoAi
  const [actionTextDrafts, setActionTextDrafts] = useState<
    Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>
  >({})
  const [customCommandDraft, setCustomCommandDraft] = useState<string | null>(null)
  const [savingActionIds, setSavingActionIds] = useState<
    Partial<Record<SourceControlActionId, boolean>>
  >({})
  const lastSyncedRepoIdRef = useRef(repoId)
  const pendingWritesRef = useRef(0)

  const queueRef = useRef<ReturnType<typeof createRepoAiPersistQueue>>(undefined!)
  queueRef.current ??= createRepoAiPersistQueue({
    getRepoId: () => repoIdRef.current,
    getPersisted: () => persistedRef.current,
    setPersisted: (value) => {
      persistedRef.current = value
      if (mountedRef.current) {
        setBaselineRepoAiRef.current(value)
      }
    },
    updateRepo: (id, updates) => updateRepoRef.current(id, updates),
    isMounted: () => mountedRef.current,
    onError: (message) => {
      if (mountedRef.current) {
        setSaveError(message)
      }
    }
  })

  useEffect(() => {
    const repoChanged = lastSyncedRepoIdRef.current !== repoId
    lastSyncedRepoIdRef.current = repoId
    persistedRef.current = persistedRepoAi
    setBaselineRepoAi(persistedRepoAi)
    if (repoChanged) {
      pendingWritesRef.current = 0
      setImmediateRepoAi(persistedRepoAi)
      setActionTextDrafts({})
      setCustomCommandDraft(null)
      setSavingActionIds({})
      setSaveError(null)
      return
    }
    if (pendingWritesRef.current === 0) {
      setImmediateRepoAi(persistedRepoAi)
    }
    setCustomCommandDraft((current) =>
      retainCustomCommandDraft(current, persistedRepoAi.customAgentCommand)
    )
    setActionTextDrafts((current) => retainDivergentActionTextDrafts(current, persistedRepoAi))
  }, [persistedSerialized, persistedRepoAi, repoId])

  const commitImmediate = (next: RepoSourceControlAiOverrides): void => {
    immediateRepoAiRef.current = next
    setImmediateRepoAi(next)
  }

  const beginWrite = (): string => {
    setSaveError(null)
    pendingWritesRef.current += 1
    return repoIdRef.current
  }

  const endWrite = (repoIdForWrite: string): boolean => {
    pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1)
    return repoIdRef.current === repoIdForWrite && mountedRef.current
  }

  const persist = (
    transform: (base: RepoSourceControlAiOverrides) => RepoSourceControlAiOverrides,
    onSuccess?: () => void
  ): void => {
    const repoIdForWrite = beginWrite()
    void queueRef.current.persistTransform(transform).then((ok) => {
      if (!endWrite(repoIdForWrite)) {
        return
      }
      // Roll back only without sibling writes so one failed field cannot erase another.
      if (!ok && pendingWritesRef.current === 0) {
        commitImmediate(persistedRef.current)
      }
      if (ok) {
        onSuccess?.()
      }
    })
  }

  const updateEnablement = (value: boolean | undefined): void => {
    commitImmediate(withRepoAiEnabled(immediateRepoAiRef.current, value))
    persist((base) => withRepoAiEnabled(base, value))
  }

  const commitCustomCommand = (value: string | undefined): void => {
    setCustomCommandDraft(value ?? '')
    // Unchanged blur must not enter the persistence queue.
    const next = withRepoAiCustomCommand(persistedRef.current, value)
    if (JSON.stringify(next) === JSON.stringify(persistedRef.current)) {
      setCustomCommandDraft((latest) => (latest === (value ?? '') ? null : latest))
      return
    }
    const repoIdForWrite = beginWrite()
    void queueRef.current
      .persistTransform((base) => withRepoAiCustomCommand(base, value))
      .then((ok) => {
        if (!endWrite(repoIdForWrite) || !ok) {
          return
        }
        commitImmediate(withRepoAiCustomCommand(immediateRepoAiRef.current, value))
        setCustomCommandDraft((latest) => (latest === (value ?? '') ? null : latest))
      })
  }

  const updateHostedReviewDefault = (key: HostedReviewDefaultKey, value: string): void => {
    const tri = value === 'on' || value === 'off' || value === 'inherit' ? value : 'inherit'
    commitImmediate(withRepoAiHostedReviewDefault(immediateRepoAiRef.current, key, tri))
    persist((base) => withRepoAiHostedReviewDefault(base, key, tri))
  }

  const updateActionMode = (actionId: SourceControlActionId, mode: string): void => {
    const nextMode = mode === ACTION_MODE_INHERIT ? 'inherit' : 'override'
    if (nextMode === 'inherit') {
      setActionTextDrafts((current) => {
        const { [actionId]: _removed, ...rest } = current
        return rest
      })
    }
    commitImmediate(withRepoAiActionMode(immediateRepoAiRef.current, settings, actionId, nextMode))
    persist((base) => withRepoAiActionMode(base, settings, actionId, nextMode))
  }

  const updateActionAgent = (
    actionId: SourceControlActionId,
    value: string,
    choice?: Pick<SourceControlActionRecipe, 'surface'>
  ): void => {
    const agentId =
      value === DEFAULT_AGENT_VALUE
        ? null
        : value === CUSTOM_AGENT_ID
          ? CUSTOM_AGENT_ID
          : (value as TuiAgent)
    const changed =
      readCompleteRecipeForDraft(immediateRepoAiRef.current, settings, actionId).agentId !== agentId
    const captured = actionTextDrafts[actionId]?.launchPreferences
    commitImmediate(
      withRepoAiActionAgent(immediateRepoAiRef.current, settings, actionId, agentId, choice)
    )
    persist(
      (base) => withRepoAiActionAgent(base, settings, actionId, agentId, choice),
      () => {
        if (changed) {
          setActionTextDrafts((current) =>
            resetActionDraftLaunchPreferences(current, actionId, agentId, captured)
          )
        }
      }
    )
  }

  const {
    updateActionLaunchPreferences,
    updateActionTemplate,
    updateActionAgentArgs,
    appendVariable
  } = createRepoActionTextDraftEditors(setActionTextDrafts, immediateRepoAiRef, source)

  const actionDirtyById = useMemo(
    () => computeActionDirtyById(immediateRepoAi, baselineRepoAi, actionTextDrafts),
    [actionTextDrafts, baselineRepoAi, immediateRepoAi]
  )

  const saveActionRecipeText = async (actionId: SourceControlActionId): Promise<void> => {
    if (!actionDirtyById[actionId] || savingActionIds[actionId]) {
      return
    }
    const draft = liftActionPermissionArgs(
      {
        ...(actionTextDrafts[actionId] ??
          readActionRecipeTextDraft(immediateRepoAiRef.current, actionId)),
        agentId: immediateRepoAiRef.current.actionOverrides?.[actionId]?.agentId
      },
      true,
      actionId
    )
    setSavingActionIds((current) => ({ ...current, [actionId]: true }))
    const repoIdForWrite = beginWrite()
    try {
      const ok = await queueRef.current.persistTransform((base) => {
        let next = base
        if (!hasOwnActionOverride(next.actionOverrides, actionId)) {
          next = withRepoAiActionMode(next, settings, actionId, 'override')
        }
        return withRepoAiActionRecipeText(next, settings, actionId, draft)
      })
      if (repoIdRef.current !== repoIdForWrite || !mountedRef.current || !ok) {
        return
      }
      setImmediateRepoAi((current) => {
        const next = withRepoAiActionRecipeText(current, settings, actionId, draft)
        immediateRepoAiRef.current = next
        return next
      })
      setActionTextDrafts((current) =>
        clearActionTextDraftIfUnchanged(current, actionId, actionTextDrafts[actionId] ?? draft)
      )
    } finally {
      pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1)
      if (mountedRef.current && repoIdRef.current === repoIdForWrite) {
        setSavingActionIds((current) => ({ ...current, [actionId]: false }))
      }
    }
  }

  const discardActionRecipeText = (actionId: SourceControlActionId): void => {
    setActionTextDrafts((current) => {
      const { [actionId]: _removed, ...rest } = current
      return rest
    })
  }

  const displayRepoAi = useMemo(
    () => composeDisplayRepoAi(immediateRepoAi, customCommandDraft, actionTextDrafts, settings),
    [actionTextDrafts, customCommandDraft, immediateRepoAi, settings]
  )

  return {
    displayRepoAi,
    saveError,
    actionDirtyById,
    savingActionIds,
    updateEnablement,
    updateCustomCommand: (value: string | undefined) => setCustomCommandDraft(value ?? ''),
    commitCustomCommand,
    updateHostedReviewDefault,
    updateActionMode,
    updateActionAgent,
    updateActionLaunchPreferences,
    updateActionTemplate,
    updateActionAgentArgs,
    appendVariable,
    saveActionRecipeText,
    discardActionRecipeText
  }
}
