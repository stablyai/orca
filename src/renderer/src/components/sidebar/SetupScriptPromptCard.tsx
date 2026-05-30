import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, LoaderCircle, Settings, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { track } from '@/lib/telemetry'
import { cn } from '@/lib/utils'
import { getRepositoryLocalCommandsSectionId } from '@/components/settings/repository-settings-targets'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  checkRuntimeHooks,
  inspectRuntimeSetupScriptImports,
  type HookCheckResult
} from '@/runtime/runtime-hooks-client'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo, RepoHookSettings } from '../../../../shared/types'
import type { SetupScriptImportCandidate } from '../../../../shared/setup-script-imports'
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from '../../../../shared/setup-script-telemetry'

type PromptState = {
  repoId: string
  hasEffectiveSetup: boolean
  hasSharedHooks: boolean
  candidate: SetupScriptImportCandidate | null
}

function hasEffectiveSetupCommand(repo: Repo, hooksResult: HookCheckResult): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  const sharedSetup = hooksResult.hooks?.scripts?.setup?.trim()
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const sourcePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (sourcePolicy === 'local-only') {
    return Boolean(localSetup)
  }

  if (sourcePolicy === 'run-both') {
    return Boolean(sharedSetup || localSetup)
  }

  return Boolean(sharedSetup)
}

function buildImportedHookSettings(
  repo: Repo,
  candidate: SetupScriptImportCandidate,
  hasSharedHooks: boolean
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  const current = repo.hookSettings
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    // Why: imported setup commands are stored as local settings. If a shared
    // hook file exists, run-both preserves its archive hook; otherwise local
    // settings need to be authoritative so the imported setup actually runs.
    commandSourcePolicy: hasSharedHooks ? 'run-both' : 'local-only',
    scripts: {
      ...defaults.scripts,
      ...current?.scripts,
      setup: candidate.setup,
      archive: candidate.archive ?? current?.scripts?.archive ?? defaults.scripts.archive
    }
  }
}

function formatCandidateSource(candidate: SetupScriptImportCandidate): string {
  const [primaryFile, ...remainingFiles] = candidate.files
  if (!primaryFile) {
    return candidate.label
  }
  return remainingFiles.length > 0
    ? `${candidate.label} (${primaryFile} +${remainingFiles.length})`
    : `${candidate.label} (${primaryFile})`
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
  const [isImporting, setIsImporting] = useState(false)
  const trackedPromptKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useMountedRef()

  const activeRepo = useMemo(
    () => repos.find((repo) => repo.id === activeRepoId) ?? null,
    [activeRepoId, repos]
  )
  const isDismissed = activeRepo ? dismissedRepoIds.includes(activeRepo.id) : false

  useEffect(() => {
    if (!sidebarOpen || !activeRepo || !isGitRepoKind(activeRepo) || isDismissed) {
      setPromptState(null)
      return
    }

    const repo = activeRepo
    let cancelled = false
    setPromptState(null)

    async function inspectRepoSetup(): Promise<void> {
      try {
        const hooksResult = await checkRuntimeHooks(settings, repo.id)
        if (cancelled) {
          return
        }

        const hasEffectiveSetup = hasEffectiveSetupCommand(repo, hooksResult)
        if (hasEffectiveSetup) {
          setPromptState({
            repoId: repo.id,
            hasEffectiveSetup: true,
            hasSharedHooks: hooksResult.hasHooks,
            candidate: null
          })
          return
        }

        const candidates = await inspectRuntimeSetupScriptImports(settings, repo.id).catch(() => [])
        if (cancelled) {
          return
        }

        setPromptState({
          repoId: repo.id,
          hasEffectiveSetup: false,
          hasSharedHooks: hooksResult.hasHooks,
          candidate: candidates[0] ?? null
        })
      } catch (error) {
        if (!cancelled) {
          console.warn('[setup-script-prompt] Failed to inspect setup scripts:', error)
          setPromptState(null)
        }
      }
    }

    void inspectRepoSetup()

    return () => {
      cancelled = true
    }
  }, [activeRepo, isDismissed, settings, sidebarOpen])

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

  useEffect(() => {
    if (
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      promptState?.repoId !== activeRepo.id ||
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
    if (promptState?.repoId === activeRepo.id && !promptState.hasEffectiveSetup) {
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
      if (promptState?.repoId === activeRepo.id && !promptState.hasEffectiveSetup) {
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

  const handleImport = useCallback(async () => {
    if (!activeRepo || !promptState?.candidate) {
      return
    }
    setIsImporting(true)
    try {
      const importedRepoId = activeRepo.id
      const nextSettings = buildImportedHookSettings(
        activeRepo,
        promptState.candidate,
        promptState.hasSharedHooks
      )
      const didUpdate = await updateRepo(activeRepo.id, { hookSettings: nextSettings })
      if (!didUpdate) {
        track(
          'setup_script_prompt_action',
          buildSetupScriptPromptActionTelemetry({
            action: 'import_failed',
            candidate: promptState.candidate,
            hasSharedHooks: promptState.hasSharedHooks
          })
        )
        if (mountedRef.current) {
          toast.error('Failed to import setup script')
        }
        return
      }
      track(
        'setup_script_prompt_action',
        buildSetupScriptPromptActionTelemetry({
          action: 'import_completed',
          candidate: promptState.candidate,
          hasSharedHooks: promptState.hasSharedHooks
        })
      )
      if (mountedRef.current) {
        setPromptState((current) =>
          current?.repoId === activeRepo.id ? { ...current, hasEffectiveSetup: true } : current
        )
        const skippedCount = promptState.candidate.unsupportedFields?.length ?? 0
        toast.success('Setup script imported', {
          description:
            skippedCount > 0
              ? `${skippedCount} unsupported field${skippedCount === 1 ? '' : 's'} skipped. Saved to this repo's local settings.`
              : "Saved to this repo's local settings.",
          action: {
            label: 'View in Settings',
            onClick: () => openLocalCommandSettings(importedRepoId)
          }
        })
      }
    } catch (error) {
      track(
        'setup_script_prompt_action',
        buildSetupScriptPromptActionTelemetry({
          action: 'import_failed',
          candidate: promptState.candidate,
          hasSharedHooks: promptState.hasSharedHooks
        })
      )
      console.warn('[setup-script-prompt] Failed to import setup script:', error)
      if (mountedRef.current) {
        toast.error('Failed to import setup script')
      }
    } finally {
      if (mountedRef.current) {
        setIsImporting(false)
      }
    }
  }, [activeRepo, mountedRef, openLocalCommandSettings, promptState, updateRepo])

  if (
    !sidebarOpen ||
    !activeRepo ||
    !isGitRepoKind(activeRepo) ||
    isDismissed ||
    promptState?.repoId !== activeRepo.id ||
    promptState.hasEffectiveSetup
  ) {
    return null
  }

  const candidate = promptState.candidate
  const title = 'Setup scripts'
  const candidateSource = candidate ? formatCandidateSource(candidate) : null
  const actionLabel = candidate ? 'Import setup' : 'Configure'
  const ActionIcon = candidate ? Download : Settings

  return (
    <div className="px-3 pb-2">
      <div className="rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-sidebar-accent-foreground shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold leading-snug">{title}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss setup scripts"
                className="-mr-1 text-muted-foreground"
                onClick={handleDismiss}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Dismiss
            </TooltipContent>
          </Tooltip>
        </div>

        <p className="mt-1 text-xs leading-snug text-muted-foreground">
          {candidateSource ? (
            <>
              Detected setup config from <span className="break-words">{candidateSource}</span>.
            </>
          ) : (
            <>
              Automate workspace setup for{' '}
              <span className="inline-flex items-center gap-1.5 align-baseline px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60">
                <RepoBadgeMark color={activeRepo.badgeColor} />
                <span className="text-[10px] font-semibold text-foreground truncate max-w-[8rem] leading-none lowercase">
                  {activeRepo.displayName}
                </span>
              </span>
            </>
          )}
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-7 w-full text-xs"
          onClick={candidate ? () => void handleImport() : handleConfigure}
          disabled={isImporting}
        >
          {isImporting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <ActionIcon className="size-3.5" />
          )}
          <span className={cn('truncate', isImporting && 'text-muted-foreground')}>
            {actionLabel}
          </span>
        </Button>
      </div>
    </div>
  )
}

export default React.memo(SetupScriptPromptCard)
