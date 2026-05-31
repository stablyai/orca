import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track } from '@/lib/telemetry'
import { getRepositoryLocalCommandsSectionId } from '@/components/settings/repository-settings-targets'
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
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from '../../../../shared/setup-script-telemetry'
import {
  ConfigureOnlyAction,
  DetectedSetupPreview,
  DismissButton,
  InspectionErrorActions,
  PackageManagerActions,
  SaveLocalSetupAction,
  SetupScriptPromptBody
} from './SetupScriptPromptCardViews'

type PromptState = SetupScriptPromptInspection

type SavedInProjectSettingsToastProps = {
  onOpenSettings: () => void
}

function SavedInProjectSettingsToast({
  onOpenSettings
}: SavedInProjectSettingsToastProps): React.JSX.Element {
  return (
    <span>
      Saved in this{' '}
      <button
        type="button"
        className="rounded-sm font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onOpenSettings}
      >
        project&apos;s settings
      </button>
    </span>
  )
}

function showSavedInProjectSettingsToast(input: {
  onOpenSettings: () => void
  description?: React.ReactNode
}): void {
  // Why: the save confirmation is also the fastest path back to the exact
  // local setup editor the user just changed.
  toast.success(<SavedInProjectSettingsToast onOpenSettings={input.onOpenSettings} />, {
    description: input.description
  })
}

function SetupScriptPromptCard(): React.JSX.Element | null {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const repos = useAppStore((s) => s.repos)
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
  const isDismissed = activeRepo
    ? isSetupScriptPromptDismissed(activeRepo.id, dismissedRepoIds)
    : false

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
      // Why: imported setup commands are local repo settings; a stale Settings
      // search should not hide the exact editor this action opens.
      setSettingsSearchQuery('')
      openSettingsTarget({
        pane: 'repo',
        repoId,
        sectionId: getRepositoryLocalCommandsSectionId(repoId)
      })
      openSettingsPage()
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

    const telemetry = buildSetupScriptPromptTelemetry({
      candidate: promptState.candidate,
      hasSharedHooks: promptState.hasSharedHooks
    })
    // Why: React may re-render the sidebar often; this event should represent
    // a distinct prompt exposure for this repo/source, not render churn.
    const promptKey = [
      activeRepo.id,
      telemetry.mode,
      telemetry.provider ?? 'none',
      telemetry.file_count_bucket,
      telemetry.unsupported_field_count_bucket,
      String(telemetry.has_shared_hooks)
    ].join(':')
    if (trackedPromptKeysRef.current.has(promptKey)) {
      return
    }

    trackedPromptKeysRef.current.add(promptKey)
    track('setup_script_prompt_shown', telemetry)
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
            toast.error('Failed to save setup script')
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
          // Why: the user has already reviewed the detected script in the
          // card; after saving, close the prompt instead of showing a second
          // confirmation panel.
          if (mountedRef.current) {
            setPromptState((current) =>
              current?.repoId === activeRepo.id && current.status === 'ok'
                ? { ...current, hasEffectiveSetup: true }
                : current
            )
            showSavedInProjectSettingsToast({
              onOpenSettings: () => openLocalCommandSettings(importedRepoId),
              description: 'Orca will run this command each time a new worktree is created.'
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
                ? `${skippedCount} unsupported field${skippedCount === 1 ? '' : 's'} skipped. Saved locally; move it to orca.yaml later to share it.`
                : 'Move it to orca.yaml later to share it.'
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
          toast.error('Failed to save setup script')
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
      toast.error('Setup script cannot be empty')
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
    return null
  }

  if (
    promptState?.repoId !== activeRepo.id ||
    (promptState.status === 'ok' && promptState.hasEffectiveSetup)
  ) {
    return null
  }

  const isInspectionError = promptState.status === 'error'
  const candidate = promptState.status === 'ok' ? promptState.candidate : null
  const isPackageManagerSuggestion = candidate?.provider === 'package-manager'
  const sharedSetupIgnored =
    promptState.status === 'ok' && candidate === null && ignoresSharedSetupScripts(activeRepo)
  const candidateSource = candidate ? formatCandidateSource(candidate) : null
  const candidateProvenance = candidate ? formatCandidateProvenance(candidate) : null

  return (
    <div className="px-3 pb-2">
      <div className="rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-sidebar-accent-foreground shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold leading-snug">Add a setup script</p>
          <DismissButton onDismiss={handleDismiss} />
        </div>

        <p className="mt-1 text-xs leading-snug text-muted-foreground">
          <SetupScriptPromptBody
            repo={activeRepo}
            isInspectionError={isInspectionError}
            sharedSetupIgnored={sharedSetupIgnored}
            isPackageManagerSuggestion={Boolean(isPackageManagerSuggestion && candidate)}
            candidateSource={candidateSource}
          />
        </p>

        {!isInspectionError && !sharedSetupIgnored && candidate && isPackageManagerSuggestion ? (
          <DetectedSetupPreview
            setup={detectedSetupDraft}
            onSetupChange={setDetectedSetupDraft}
            provenance={candidateProvenance}
          />
        ) : null}

        {isInspectionError ? (
          <InspectionErrorActions onRetry={handleRetryInspection} onConfigure={handleConfigure} />
        ) : sharedSetupIgnored ? (
          <ConfigureOnlyAction onConfigure={handleConfigure} />
        ) : candidate && isPackageManagerSuggestion ? (
          <PackageManagerActions
            isSaving={isImporting}
            onSave={() => void handleImport()}
            onConfigure={handleConfigure}
          />
        ) : candidate ? (
          <SaveLocalSetupAction isSaving={isImporting} onSave={() => void handleImport()} />
        ) : promptState.status === 'ok' ? (
          <ConfigureOnlyAction onConfigure={handleConfigure} />
        ) : null}
      </div>
    </div>
  )
}

export default React.memo(SetupScriptPromptCard)
