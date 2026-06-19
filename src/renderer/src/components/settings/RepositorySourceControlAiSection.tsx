import { useMemo, useState } from 'react'
import type React from 'react'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import {
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings,
  resolveSourceControlActionRecipe
} from '../../../../shared/source-control-ai'
import { toSourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import type { SourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import type { SourceControlActionId } from '../../../../shared/source-control-ai-actions'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getRepositorySourceControlAiSectionId } from './repository-settings-targets'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiCustomCommand } from './RepositorySourceControlAiCustomCommand'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { RepositorySourceControlAiHostedReviewDefaults } from './RepositorySourceControlAiHostedReviewDefaults'
import {
  createRepoAiDraftState,
  dropRepoLegacyInstructionForAction,
  hasOwnActionOverride,
  normalizeRepoAiDraft,
  resolveRepoAiDraftState,
  serializeRepoAiDraft,
  type RepoAiDraftState
} from './repository-source-control-ai-draft'
import {
  ACTION_MODE_INHERIT,
  DEFAULT_AGENT_VALUE,
  completeRepoActionRecipe,
  readInheritedCommandTemplate
} from './repository-source-control-ai-labels'
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'

export {
  createRepoAiDraftState,
  dropRepoLegacyInstructionForAction,
  resolveRepoAiDraftState
} from './repository-source-control-ai-draft'

type RepositorySourceControlAiSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>
}

type HostedReviewDefaultKey = keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>

function readCompleteRecipeForDraft(
  current: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId
): NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
> {
  const recipe = resolveSourceControlActionRecipe({
    settings,
    repo: { sourceControlAi: current },
    actionId
  })
  return completeRepoActionRecipe(recipe, actionId)
}

function setActionOverride(
  current: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId,
  recipe: NonNullable<
    NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
  >
): RepoSourceControlAiOverrides {
  return dropRepoLegacyInstructionForAction(
    {
      ...current,
      actionOverrides: {
        ...current.actionOverrides,
        [actionId]: recipe
      }
    },
    actionId
  )
}

export function RepositorySourceControlAiSection({
  repo,
  updateRepo
}: RepositorySourceControlAiSectionProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const settings = useAppStore((state) => state.settings)
  const ownership = getSettingOwnershipSummary('repositorySourceControlAi')
  const source = normalizeSourceControlAiSettings(
    settings?.sourceControlAi,
    settings?.commitMessageAi
  )
  const persistedRepoAi = useMemo(
    () => normalizeRepoAiDraft(repo.sourceControlAi),
    [repo.sourceControlAi]
  )
  const persistedSerialized = useMemo(
    () => serializeRepoAiDraft(persistedRepoAi),
    [persistedRepoAi]
  )
  // Why: repo.sourceControlAi is saved as one nested value; a local draft keeps
  // textarea keystrokes and sibling controls from racing over IPC/RPC.
  const [draftState, setDraftState] = useState<RepoAiDraftState>(() =>
    createRepoAiDraftState(repo.id, persistedRepoAi)
  )
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const resolvedDraftState = resolveRepoAiDraftState(
    draftState,
    repo.id,
    persistedRepoAi,
    persistedSerialized
  )
  if (resolvedDraftState !== draftState) {
    // Why: repo settings may be refreshed externally; clean drafts should
    // follow that source before paint, while dirty edits stay in place.
    setDraftState(resolvedDraftState)
    if (saveError !== null) {
      setSaveError(null)
    }
  }

  const repoAi = resolvedDraftState.value
  const draftSerialized = useMemo(() => serializeRepoAiDraft(repoAi), [repoAi])
  const isDirty =
    resolvedDraftState.repoId !== repo.id || draftSerialized !== resolvedDraftState.baseSerialized

  const updateDraftRepoAi = (
    update: (current: RepoSourceControlAiOverrides) => RepoSourceControlAiOverrides
  ): void => {
    setDraftState((current) => {
      const resolved = resolveRepoAiDraftState(
        current,
        repo.id,
        persistedRepoAi,
        persistedSerialized
      )
      return {
        ...resolved,
        value: normalizeRepoAiDraft(update(resolved.value))
      }
    })
    setSaveError(null)
  }

  const saveDraft = async (): Promise<void> => {
    if (!isDirty || isSaving) {
      return
    }
    const next = normalizeRepoAiDraft(resolvedDraftState.value)
    const nextSerialized = serializeRepoAiDraft(next)
    const repoUpdate = toSourceControlAiRepoUpdate(next)
    setIsSaving(true)
    setSaveError(null)
    try {
      const result = await updateRepo(repo.id, repoUpdate)
      if (!mountedRef.current) {
        return
      }
      if (result === false) {
        setSaveError('Failed to save Source Control AI settings.')
        return
      }
      const savedValue =
        repoUpdate.sourceControlAi === null
          ? {}
          : (normalizeRepoSourceControlAiOverrides(repoUpdate.sourceControlAi) ?? {})
      setDraftState((current) => {
        if (current.repoId !== repo.id) {
          return current
        }
        const currentSerialized = serializeRepoAiDraft(current.value)
        return {
          repoId: repo.id,
          value: currentSerialized === nextSerialized ? savedValue : current.value,
          baseSerialized: serializeRepoAiDraft(savedValue)
        }
      })
    } catch {
      if (mountedRef.current) {
        setSaveError('Failed to save Source Control AI settings.')
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false)
      }
    }
  }

  const discardDraft = (): void => {
    setDraftState(createRepoAiDraftState(repo.id, persistedRepoAi))
    setSaveError(null)
  }

  const updateEnablement = (value: boolean | undefined): void => {
    updateDraftRepoAi((current) => ({ ...current, enabled: value }))
  }

  const updateCustomCommand = (value: string | undefined): void => {
    updateDraftRepoAi((current) => ({ ...current, customAgentCommand: value }))
  }

  const updateActionMode = (actionId: SourceControlActionId, mode: string): void => {
    updateDraftRepoAi((current) => {
      const nextActionOverrides = { ...current.actionOverrides }
      if (mode === ACTION_MODE_INHERIT) {
        delete nextActionOverrides[actionId]
        return dropRepoLegacyInstructionForAction(
          { ...current, actionOverrides: nextActionOverrides },
          actionId
        )
      }
      if (!hasOwnActionOverride(nextActionOverrides, actionId)) {
        nextActionOverrides[actionId] = readCompleteRecipeForDraft(current, settings, actionId)
      }
      return dropRepoLegacyInstructionForAction(
        { ...current, actionOverrides: nextActionOverrides },
        actionId
      )
    })
  }

  const updateActionAgent = (actionId: SourceControlActionId, value: string): void => {
    updateDraftRepoAi((current) => {
      const currentRecipe =
        current.actionOverrides?.[actionId] ??
        readCompleteRecipeForDraft(current, settings, actionId)
      const nextRecipe = {
        ...currentRecipe,
        agentId:
          value === DEFAULT_AGENT_VALUE
            ? null
            : value === CUSTOM_AGENT_ID
              ? CUSTOM_AGENT_ID
              : (value as TuiAgent)
      }
      return setActionOverride(current, actionId, nextRecipe)
    })
  }

  const updateActionTemplate = (actionId: SourceControlActionId, value: string): void => {
    updateDraftRepoAi((current) => {
      const currentRecipe =
        current.actionOverrides?.[actionId] ??
        readCompleteRecipeForDraft(current, settings, actionId)
      return setActionOverride(current, actionId, {
        ...currentRecipe,
        commandInputTemplate: value
      })
    })
  }

  const updateActionAgentArgs = (actionId: SourceControlActionId, value: string): void => {
    updateDraftRepoAi((current) => {
      const currentRecipe =
        current.actionOverrides?.[actionId] ??
        readCompleteRecipeForDraft(current, settings, actionId)
      return setActionOverride(current, actionId, {
        ...currentRecipe,
        agentArgs: value
      })
    })
  }

  const appendVariable = (actionId: SourceControlActionId, variable: string): void => {
    const override = repoAi.actionOverrides?.[actionId]
    const currentTemplate =
      typeof override?.commandInputTemplate === 'string'
        ? override.commandInputTemplate
        : readInheritedCommandTemplate(source, actionId)
    const separator = currentTemplate.endsWith('\n') || currentTemplate.length === 0 ? '' : ' '
    updateActionTemplate(actionId, `${currentTemplate}${separator}{${variable}}`)
  }

  const updateHostedReviewDefault = (key: HostedReviewDefaultKey, value: string): void => {
    updateDraftRepoAi((current) => {
      const nextDefaults = { ...current.prCreationDefaults }
      if (value === 'inherit') {
        delete nextDefaults[key]
      } else {
        nextDefaults[key] = value === 'on'
      }
      return { ...current, prCreationDefaults: nextDefaults }
    })
  }

  return (
    <section
      id={getRepositorySourceControlAiSectionId(repo.id)}
      data-settings-section={getRepositorySourceControlAiSectionId(repo.id)}
      className="space-y-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositorySourceControlAiSection.71b003b62b',
              'Source Control AI'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">{ownership.description}</p>
          {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground">
            {isDirty
              ? translate(
                  'auto.components.settings.RepositorySourceControlAiSection.e57dde9d93',
                  'Unsaved changes'
                )
              : translate(
                  'auto.components.settings.RepositorySourceControlAiSection.ccb07dd027',
                  'Saved'
                )}
          </span>
          {isDirty ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={discardDraft}
              disabled={isSaving}
            >
              {translate(
                'auto.components.settings.RepositorySourceControlAiSection.67b3ff5467',
                'Discard'
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => void saveDraft()}
            disabled={!isDirty || isSaving}
          >
            {isSaving
              ? translate(
                  'auto.components.settings.RepositorySourceControlAiSection.57e6e9d4b1',
                  'Saving...'
                )
              : translate(
                  'auto.components.settings.RepositorySourceControlAiSection.152268c295',
                  'Save'
                )}
          </Button>
        </div>
      </div>

      <RepositorySourceControlAiEnablement
        value={repoAi.enabled}
        source={source}
        onChange={updateEnablement}
      />
      <RepositorySourceControlAiCustomCommand
        value={repoAi.customAgentCommand}
        source={source}
        onChange={updateCustomCommand}
      />
      <RepositorySourceControlAiActionRows
        repoAi={repoAi}
        source={source}
        defaultTuiAgent={settings?.defaultTuiAgent}
        onActionModeChange={updateActionMode}
        onActionAgentChange={updateActionAgent}
        onActionTemplateChange={updateActionTemplate}
        onActionAgentArgsChange={updateActionAgentArgs}
        onAppendVariable={appendVariable}
      />
      <RepositorySourceControlAiHostedReviewDefaults
        value={repoAi.prCreationDefaults}
        source={source}
        onChange={updateHostedReviewDefault}
      />
    </section>
  )
}
