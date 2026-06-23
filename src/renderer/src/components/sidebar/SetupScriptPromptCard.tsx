import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track } from '@/lib/telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  buildImportedHookSettings,
  formatCandidateProvenance,
  formatCandidateSource,
  isSetupScriptPromptDismissed,
  ignoresSharedSetupScripts,
  inspectSetupScriptPromptState,
  type SetupScriptPromptInspection
} from '@/lib/setup-script-prompt'
import { checkRuntimeHooks, inspectRuntimeSetupScriptImports } from '@/runtime/runtime-hooks-client'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { SetupScriptImportCandidate } from '../../../../shared/setup-script-imports'
import { buildSetupScriptPromptActionTelemetry } from '../../../../shared/setup-script-telemetry'
import { SetupScriptPromptCardShell } from './SetupScriptPromptCardShell'
import { showSavedInProjectSettingsToast } from './SetupScriptPromptToast'
import { openSetupScriptSettings } from './open-setup-script-settings'
import { trackSetupScriptPromptExposure } from './setup-script-prompt-exposure-telemetry'
import {
  getRenderedSetupScriptPromptState,
  getRepoProjectId,
  type LastVisibleSetupScriptPrompt,
  useSetupScriptPromptProjectContext
} from './setup-script-prompt-render-state'
import { translate } from '@/i18n/i18n'

type PromptState = SetupScriptPromptInspection

function SetupScriptPromptCard(): React.JSX.Element | null {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const repos = useAppStore((s) => s.repos)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const settings = useAppStore((s) => s.settings)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const dismissedRepoIds = useAppStore((s) => s.setupScriptPromptDismissedRepoIds)
  const dismissSetupScriptPrompt = useAppStore((s) => s.dismissSetupScriptPrompt)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [detectedSetupDraft, setDetectedSetupDraft] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [inspectionRetryKey, setInspectionRetryKey] = useState(0)
  const trackedPromptKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useMountedRef()

  const activeRepo = useMemo(
    () => repos.find((repo) => repo.id === activeRepoId) ?? null,
    [activeRepoId, repos]
  )
  const { activeProjectId, setupByRepoId } = useSetupScriptPromptProjectContext(
    activeRepo,
    repos,
    projectHostSetups
  )
  const isDismissed = activeRepo
    ? isSetupScriptPromptDismissed(activeRepo.id, dismissedRepoIds)
    : false
  const lastVisiblePromptRef = useRef<LastVisibleSetupScriptPrompt | null>(null)

  useEffect(() => {
    if (!sidebarOpen || !activeRepo || !isGitRepoKind(activeRepo) || isDismissed) {
      setPromptState(null)
      setDetectedSetupDraft('')
      return
    }

    const repo = activeRepo
    let cancelled = false
    setPromptState(null)

    async function inspectRepoSetup(): Promise<void> {
      const nextState = await inspectSetupScriptPromptState({
        repo,
        checkHooks: () => checkRuntimeHooks(settings, repo.id),
        inspectImports: () => inspectRuntimeSetupScriptImports(settings, repo.id)
      })
      if (!cancelled) {
        setPromptState(nextState)
        setDetectedSetupDraft(
          nextState.status === 'ok' && nextState.candidate?.provider === 'package-manager'
            ? nextState.candidate.setup
            : ''
        )
      }
    }

    void inspectRepoSetup()

    return () => {
      cancelled = true
    }
  }, [activeRepo, inspectionRetryKey, isDismissed, settings, sidebarOpen])

  const openLocalCommandSettings = useCallback(
    (repoId: string) => {
      openSetupScriptSettings({
        repoId,
        setSettingsSearchQuery,
        openSettingsTarget,
        openSettingsPage
      })
    },
    [openSettingsPage, openSettingsTarget, setSettingsSearchQuery]
  )

  const handleRetryInspection = useCallback(() => {
    setInspectionRetryKey((value) => value + 1)
  }, [])

  useEffect(() => {
    if (
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      promptState?.repoId !== activeRepo.id ||
      promptState.status !== 'ok' ||
      promptState.hasEffectiveSetup
    ) {
      return
    }

    trackSetupScriptPromptExposure({
      repoId: activeRepo.id,
      promptState,
      trackedPromptKeys: trackedPromptKeysRef.current
    })
  }, [activeRepo, isDismissed, promptState, sidebarOpen])

  const handleConfigure = useCallback(() => {
    if (!activeRepo) {
      return
    }
    if (
      promptState?.repoId === activeRepo.id &&
      promptState.status === 'ok' &&
      !promptState.hasEffectiveSetup
    ) {
      track(
        'setup_script_prompt_action',
        buildSetupScriptPromptActionTelemetry({
          action: 'configure_clicked',
          candidate: promptState.candidate,
          hasSharedHooks: promptState.hasSharedHooks
        })
      )
    }
    openLocalCommandSettings(activeRepo.id)
  }, [activeRepo, openLocalCommandSettings, promptState])

  const handleDismiss = useCallback(() => {
    if (activeRepo) {
      if (
        promptState?.repoId === activeRepo.id &&
        promptState.status === 'ok' &&
        !promptState.hasEffectiveSetup
      ) {
        track(
          'setup_script_prompt_action',
          buildSetupScriptPromptActionTelemetry({
            action: 'dismissed',
            candidate: promptState.candidate,
            hasSharedHooks: promptState.hasSharedHooks
          })
        )
      }
      dismissSetupScriptPrompt(activeRepo.id)
    }
  }, [activeRepo, dismissSetupScriptPrompt, promptState])

  const saveSetupCandidate = useCallback(
    async (input: {
      candidate: SetupScriptImportCandidate
      hasSharedHooks: boolean
      actionPrefix: 'save_detected_setup' | 'import'
      editedBeforeSave?: boolean
    }) => {
      const { candidate, hasSharedHooks, actionPrefix, editedBeforeSave } = input
      if (!activeRepo) {
        return
      }
      setIsImporting(true)
      try {
        const importedRepoId = activeRepo.id
        const nextSettings = buildImportedHookSettings(activeRepo, candidate, hasSharedHooks)
        const didUpdate = await updateRepo(activeRepo.id, { hookSettings: nextSettings })
        if (!didUpdate) {
          track(
            'setup_script_prompt_action',
            buildSetupScriptPromptActionTelemetry({
              action:
                actionPrefix === 'save_detected_setup'
                  ? 'save_detected_setup_failed'
                  : 'import_failed',
              candidate,
              hasSharedHooks,
              editedBeforeSave
            })
          )
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.sidebar.SetupScriptPromptCard.888b83bf78',
                'Failed to save setup script'
              )
            )
          }
          return
        }
        track(
          'setup_script_prompt_action',
          buildSetupScriptPromptActionTelemetry({
            action:
              actionPrefix === 'save_detected_setup'
                ? 'save_detected_setup_completed'
                : 'import_completed',
            candidate,
            hasSharedHooks,
            editedBeforeSave
          })
        )
        if (actionPrefix === 'save_detected_setup') {
          if (mountedRef.current) {
            setPromptState((current) =>
              current?.repoId === activeRepo.id && current.status === 'ok'
                ? { ...current, hasEffectiveSetup: true }
                : current
            )
            showSavedInProjectSettingsToast({
              onOpenSettings: () => openLocalCommandSettings(importedRepoId),
              description: translate(
                'auto.components.sidebar.SetupScriptPromptCard.a49196d538',
                'Runs when Orca creates a new worktree.'
              )
            })
          }
          return
        }
        if (mountedRef.current) {
          setPromptState((current) =>
            current?.repoId === activeRepo.id && current.status === 'ok'
              ? { ...current, hasEffectiveSetup: true }
              : current
          )
          const skippedCount = candidate.unsupportedFields?.length ?? 0
          showSavedInProjectSettingsToast({
            onOpenSettings: () => openLocalCommandSettings(importedRepoId),
            description:
              skippedCount > 0
                ? `${skippedCount} unsupported field${skippedCount === 1 ? '' : 's'} skipped. Saved the setup command.`
                : 'Saved the setup command.'
          })
        }
      } catch (error) {
        track(
          'setup_script_prompt_action',
          buildSetupScriptPromptActionTelemetry({
            action:
              actionPrefix === 'save_detected_setup'
                ? 'save_detected_setup_failed'
                : 'import_failed',
            candidate,
            hasSharedHooks,
            editedBeforeSave
          })
        )
        console.warn('[setup-script-prompt] Failed to save setup script:', error)
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.sidebar.SetupScriptPromptCard.888b83bf78',
              'Failed to save setup script'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setIsImporting(false)
        }
      }
    },
    [activeRepo, mountedRef, openLocalCommandSettings, updateRepo]
  )

  const handleImport = useCallback(async () => {
    if (!activeRepo || promptState?.status !== 'ok' || !promptState.candidate) {
      return
    }
    const isPackageManagerCandidate = promptState.candidate.provider === 'package-manager'
    const actionPrefix = isPackageManagerCandidate ? 'save_detected_setup' : 'import'
    const editedBeforeSave =
      isPackageManagerCandidate && detectedSetupDraft.trim() !== promptState.candidate.setup.trim()
    const candidate = isPackageManagerCandidate
      ? {
          ...promptState.candidate,
          setup: detectedSetupDraft.trim()
        }
      : promptState.candidate
    if (!candidate.setup) {
      toast.error(
        translate(
          'auto.components.sidebar.SetupScriptPromptCard.70715947fb',
          'Setup script cannot be empty'
        )
      )
      return
    }
    if (actionPrefix === 'save_detected_setup') {
      track(
        'setup_script_prompt_action',
        buildSetupScriptPromptActionTelemetry({
          action: 'save_detected_setup_clicked',
          candidate,
          hasSharedHooks: promptState.hasSharedHooks,
          editedBeforeSave
        })
      )
    }
    await saveSetupCandidate({
      candidate,
      hasSharedHooks: promptState.hasSharedHooks,
      actionPrefix,
      editedBeforeSave: isPackageManagerCandidate ? editedBeforeSave : undefined
    })
  }, [activeRepo, detectedSetupDraft, promptState, saveSetupCandidate])

  if (!sidebarOpen || !activeRepo || !isGitRepoKind(activeRepo) || isDismissed) {
    lastVisiblePromptRef.current = null
    return null
  }

  const promptProjectId = promptState?.repoId
    ? getRepoProjectId(promptState.repoId, repos, projectHostSetups, setupByRepoId)
    : null
  const renderedPromptState =
    activeRepo &&
    getRenderedSetupScriptPromptState({
      promptState,
      activeRepoId: activeRepo.id,
      activeProjectId,
      lastVisiblePrompt: lastVisiblePromptRef.current
    })

  if (
    !renderedPromptState ||
    (renderedPromptState.status === 'ok' && renderedPromptState.hasEffectiveSetup)
  ) {
    if (renderedPromptState?.status === 'ok' && renderedPromptState.hasEffectiveSetup) {
      lastVisiblePromptRef.current = null
    }
    return null
  }

  if (
    renderedPromptState.status === 'ok' &&
    !renderedPromptState.hasEffectiveSetup &&
    (renderedPromptState.repoId === activeRepo.id || promptProjectId === activeProjectId)
  ) {
    lastVisiblePromptRef.current = {
      state: renderedPromptState,
      projectId: activeProjectId
    }
  }

  const isInspectionError = renderedPromptState.status === 'error'
  const candidate = renderedPromptState.status === 'ok' ? renderedPromptState.candidate : null
  const isPackageManagerSuggestion = candidate?.provider === 'package-manager'
  const sharedSetupIgnored =
    renderedPromptState.status === 'ok' &&
    candidate === null &&
    ignoresSharedSetupScripts(activeRepo)
  const candidateSource = candidate ? formatCandidateSource(candidate) : null
  const candidateProvenance = candidate ? formatCandidateProvenance(candidate) : null

  return (
    <SetupScriptPromptCardShell
      repoBadgeColor={activeRepo.badgeColor}
      repoDisplayName={activeRepo.displayName}
      isInspectionError={isInspectionError}
      sharedSetupIgnored={sharedSetupIgnored}
      isPackageManagerSuggestion={Boolean(isPackageManagerSuggestion && candidate)}
      hasCandidate={Boolean(candidate)}
      candidateSource={candidateSource}
      candidateProvenance={candidateProvenance}
      detectedSetupDraft={detectedSetupDraft}
      isImporting={isImporting}
      renderedStateOk={renderedPromptState.status === 'ok'}
      onDismiss={handleDismiss}
      onRetryInspection={handleRetryInspection}
      onConfigure={handleConfigure}
      onImport={() => void handleImport()}
      onSetupDraftChange={setDetectedSetupDraft}
    />
  )
}

export default React.memo(SetupScriptPromptCard)
