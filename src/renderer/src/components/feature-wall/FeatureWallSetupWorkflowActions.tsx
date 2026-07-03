import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Plus, Save, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo, RepoHookSettings, Worktree } from '../../../../shared/types'
import { getRepositoryLocalCommandsSectionId } from '../settings/repository-settings-targets'
import {
  requestContextualTourWhenReady,
  type RequestContextualTourWhenReadyArgs
} from '../contextual-tours/request-contextual-tour-when-ready'
import { translate } from '@/i18n/i18n'

export const SETUP_GUIDE_PROJECT_PROMPT = "First add a project you'd like to work on."

export function promptForSetupGuideProject(openModal: (modal: 'add-repo') => void): void {
  openModal('add-repo')
  toast.message(SETUP_GUIDE_PROJECT_PROMPT)
}

export function getSetupGuideGitRepo(
  repos: readonly Repo[],
  activeRepoId: string | null
): Repo | null {
  const activeRepo = activeRepoId
    ? repos.find((entry) => entry.id === activeRepoId && isGitRepoKind(entry))
    : undefined
  return activeRepo ?? repos.find((entry) => isGitRepoKind(entry)) ?? null
}

export function AddReposAction(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  return (
    <Button type="button" size="sm" className="w-fit gap-2" onClick={() => openModal('add-repo')}>
      <Plus className="size-3.5" />
      {translate(
        'auto.components.feature.wall.FeatureWallSetupWorkflowActions.522cce9e33',
        'Add project'
      )}
    </Button>
  )
}

export function WorkspacesAction(props: { done: boolean }): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const repos = useAppStore((s) => s.repos)
  const repo = getSetupGuideGitRepo(repos, activeRepoId)
  if (props.done) {
    return null
  }

  return (
    <Button
      type="button"
      size="sm"
      className="w-fit gap-2"
      onClick={() => {
        cancelPendingSetupGuideTourRequest()
        if (!repo) {
          promptForSetupGuideProject(openModal)
          return
        }
        const tourRequestId = createSetupGuideTourRequestId()
        openModal('new-workspace-composer', {
          initialRepoId: repo.id,
          telemetrySource: 'unknown',
          contextualTourSource: 'setup_guide_parallel_work',
          setupGuideTourRequestId: tourRequestId
        })
        requestSetupGuideTourWhenReady({
          id: 'workspace-creation',
          source: 'setup_guide_parallel_work',
          wasFeaturePreviouslyInteracted: false,
          shouldContinue: () => isSetupGuideWorkspaceComposerRequestCurrent(tourRequestId)
        })
      }}
    >
      <ArrowUpRight className="size-3.5" />
      {translate(
        'auto.components.feature.wall.FeatureWallSetupWorkflowActions.f0bbf7da77',
        'Try it out'
      )}
    </Button>
  )
}

export function SetupScriptAction(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const closeModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const repo = getSetupGuideGitRepo(repos, activeRepoId)
  const canConfigure = repo !== null
  const [setupScript, setSetupScript] = useState('pnpm install')

  useEffect(() => {
    if (!canConfigure) {
      setSetupScript('pnpm install')
      return
    }
    setSetupScript(repo.hookSettings?.scripts?.setup?.trim() || 'pnpm install')
  }, [canConfigure, repo])

  const openLocalCommandSettings = useCallback(() => {
    if (!repo || !isGitRepoKind(repo)) {
      return
    }
    setSettingsSearchQuery('')
    openSettingsTarget({
      pane: 'repo',
      repoId: repo.id,
      sectionId: getRepositoryLocalCommandsSectionId(repo.id)
    })
    closeModal()
    openSettingsPage()
  }, [closeModal, openSettingsPage, openSettingsTarget, repo, setSettingsSearchQuery])

  const handleSaveSetupScript = useCallback(async () => {
    if (!repo || !isGitRepoKind(repo)) {
      return
    }
    const current = repo.hookSettings
    const defaults = getDefaultRepoHookSettings()
    const nextHookSettings: RepoHookSettings = {
      ...defaults,
      ...current,
      setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
      // Why: setup guide edits are local repo commands and must run after save.
      commandSourcePolicy: current?.commandSourcePolicy ?? 'local-only',
      scripts: {
        ...defaults.scripts,
        ...current?.scripts,
        setup: setupScript.trim()
      }
    }
    const updated = await updateRepo(repo.id, { hookSettings: nextHookSettings })
    if (updated) {
      toast.success(
        translate(
          'auto.components.feature.wall.FeatureWallSetupWorkflowActions.6299297dac',
          'Setup script saved'
        )
      )
    } else {
      toast.error(
        translate(
          'auto.components.feature.wall.FeatureWallSetupWorkflowActions.a7463915b6',
          'Failed to save setup script'
        )
      )
    }
  }, [repo, setupScript, updateRepo])

  return (
    <div className="space-y-4">
      <div className="grid max-w-2xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={setupScript}
          disabled={!canConfigure}
          onChange={(event) => setSetupScript(event.target.value)}
          placeholder={translate(
            'auto.components.feature.wall.FeatureWallSetupWorkflowActions.5c5b65044e',
            'pnpm install'
          )}
          aria-label={translate(
            'auto.components.feature.wall.FeatureWallSetupWorkflowActions.88469e926b',
            'Setup script'
          )}
          className="font-mono text-sm"
        />
        <Button
          type="button"
          size="sm"
          className="gap-2"
          disabled={!canConfigure || setupScript.trim().length === 0}
          onClick={() => void handleSaveSetupScript()}
        >
          <Save className="size-3.5" />
          {translate(
            'auto.components.feature.wall.FeatureWallSetupWorkflowActions.14327073cc',
            'Save'
          )}
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
        disabled={!canConfigure}
        onClick={openLocalCommandSettings}
      >
        <Settings className="size-3.5" />
        {translate(
          'auto.components.feature.wall.FeatureWallSetupWorkflowActions.00078a6134',
          'View in settings'
        )}
      </Button>
      {!canConfigure ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.feature.wall.FeatureWallSetupWorkflowActions.486c2f4d8d',
            'Add a git project first, then configure the setup script for that repository.'
          )}
        </p>
      ) : null}
    </div>
  )
}

export function useSetupTargetWorktree(): Worktree | null {
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  return useMemo(
    () =>
      allWorktrees.find((worktree) => worktree.id === activeWorktreeId) ?? allWorktrees[0] ?? null,
    [activeWorktreeId, allWorktrees]
  )
}

let pendingSetupGuideTourCancel: (() => void) | null = null
let setupGuideTourRequestSequence = 0

function createSetupGuideTourRequestId(): string {
  setupGuideTourRequestSequence += 1
  return `setup-guide-tour-${setupGuideTourRequestSequence}`
}

export function cancelPendingSetupGuideTourRequest(): void {
  pendingSetupGuideTourCancel?.()
  pendingSetupGuideTourCancel = null
}

export function requestSetupGuideTourWhenReady(args: RequestContextualTourWhenReadyArgs): void {
  cancelPendingSetupGuideTourRequest()
  pendingSetupGuideTourCancel = requestContextualTourWhenReady(args)
}

export function isSetupGuideWorkspaceComposerRequestCurrent(requestId: string): boolean {
  const state = useAppStore.getState()
  const modalData = state.modalData as { setupGuideTourRequestId?: unknown }
  return (
    state.activeModal === 'new-workspace-composer' &&
    modalData.setupGuideTourRequestId === requestId
  )
}
