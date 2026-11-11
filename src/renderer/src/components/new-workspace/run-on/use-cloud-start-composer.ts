// Composer glue for Orca Cloud (composer-redo). Picking Orca Cloud changes nothing else in the
// dialog: Start either creates the workspace (everything is set up) or saves the draft, closes the
// dialog and opens the full-page setup, which starts the prompt by itself when done. Also: where
// each project last started (O5), the remembered default (D7) and GitHub-only repositories (D4).
import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { clearCloudStartDraft, saveCloudStartDraft } from '@/lib/orca-cloud/cloud-start-draft'
import {
  getCloudSetupPageRequest,
  openCloudSetupPage
} from '@/lib/orca-cloud/cloud-setup-page-store'
import {
  armCloudCreateIdempotency,
  consumeCloudCreateIntent,
  startCloudCreate
} from '@/lib/orca-cloud/cloud-create-intent'
import { recordSuccessfulRunOn } from '@/lib/orca-cloud/run-on-memory'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { ComposerModalData } from '../composer-modal-data'
import { getOrcaCloudSegmentState } from './cloud-start-model'
import { useCloudStartSteps } from './use-cloud-start-steps'
import { useSwitchTeamSteps } from '../cloud-setup/use-cloud-setup-tracker'
import { cloudSetupRequired } from '../../orca-cloud-setup/cloud-setup-page-model'
import { useRunOnDefault } from './use-run-on-default'
import { useCloudOnlyCreate, useCloudOnlyRepo } from './use-cloud-only-repo'
import {
  isGitHubBackedProject,
  orcaCloudNeedsGitHubRepo,
  type CloudStartView
} from './cloud-start-view'
import { showCloudAgentNotStartedToast } from '@/lib/orca-cloud/cloud-agent-not-started-toast'
import { orcaCloudWallNotice, useRunOnPreflightEnabled } from '@/lib/orca-cloud/run-on-preflight'
import { isOrcaCloudAccountAgent } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export type { CloudStartView } from './cloud-start-view'

/**
 * The agent isn't set up: its pane holds on the "Set up once" strip (PC-3b), so the toast only
 * names the workspace once the user has moved to another one (design-squad journey).
 */
function showAgentNotStartedToast(agent: string | null, workspaceName: string): void {
  if (isOrcaCloudAccountAgent(agent)) {
    showCloudAgentNotStartedToast(agent, workspaceName, { onlyWhenAway: true })
  }
}

export function useCloudStartComposer({
  active,
  availability,
  selectedRecipeId,
  setRecipeId,
  repoId,
  prompt,
  agent,
  initialTargetFixed,
  autoStartIntent = null,
  createReady = true,
  composerSnapshot,
  onCreate: createWorkspace,
  onClose,
  accessOverride
}: {
  active: boolean
  availability: OrcaCloudAvailability
  selectedRecipeId: string | null
  setRecipeId: ((recipeId: string | null) => void) | undefined
  repoId: string
  prompt: string
  agent: string | null
  /** The composer was opened on an explicit target (Landing card, a recovery). */
  initialTargetFixed: boolean
  /**
   * Reopened by the setup page once everything is done: the Create press's intent, submitted once
   * the form is ready (and only if nothing has used it yet).
   */
  autoStartIntent?: string | null
  /** The composer's own create would run now (project picked, agent resolved). */
  createReady?: boolean
  /** The composer as it is now, for the setup page's Back and its auto-start. */
  composerSnapshot: () => ComposerModalData
  onCreate: () => void
  /** Closes the composer (setup moves to its page; a cloud-only repository started, D4). */
  onClose?: () => void
  /** Fixtures pin the account's access. */
  accessOverride?: OrcaCloudRunTargetAccess
}): {
  view: CloudStartView | null
  /** Replaces the plain create while Orca Cloud is selected. */
  onPrimary: (() => void) | null
  /** Call from the composer's onCreated: only a successful start is remembered. */
  recordCreated: () => void
} {
  const profileId = useAppStore((s) => s.activeOrcaProfileId ?? null)
  const segment = getOrcaCloudSegmentState(availability)
  const cloudSelected = selectedRecipeId === ORCA_CLOUD_RECIPE_ID
  const fetched = useOrcaCloudRunTargetAccess(segment === 'enabled' && !accessOverride)
  const access = accessOverride ?? fetched
  const preflight = useRunOnPreflightEnabled()
  const githubProjectCount = useAppStore((s) => s.repos.filter(isGitHubBackedProject).length)
  const wall = useMemo(
    () => (cloudSelected && preflight ? orcaCloudWallNotice(access) : null),
    [access, cloudSelected, preflight]
  )
  const cloudOnly = useCloudOnlyRepo({
    repoId,
    cloudSelected,
    cloudOffered: segment === 'enabled',
    signedIn: availability !== 'needs-sign-in' && access.state !== 'signed-out'
  })
  const { steps: rowSteps } = useCloudStartSteps({
    availability,
    access,
    repoId,
    agent,
    cloudSelected,
    setupSessionId: null,
    githubOverride: cloudOnly.githubStep
  })
  const { steps, held: switchTeam } = useSwitchTeamSteps(rowSteps, cloudSelected)
  const setupNeeded = cloudSetupRequired(steps, { teamSwitch: switchTeam !== null })
  // The agent has no Orca Cloud account (the user skipped setting it up). It is still created with
  // the workspace: its launch holds on the pane's "Set up once" strip and never reaches the agent's
  // own /login (PC-3b, #385), and its first prompt waits for it.
  const agentUnset =
    cloudSelected && steps.some((step) => step.id === 'agent' && step.state === 'optional')
  const onCreateRaw = useCloudOnlyCreate({
    cloudOnly,
    createWorkspace,
    prompt,
    agent,
    profileId,
    onClose
  })
  const onCreate = useCallback(() => {
    onCreateRaw()
    if (agentUnset) {
      showAgentNotStartedToast(agent, prompt)
    }
  }, [agent, agentUnset, onCreateRaw, prompt])

  const { markTouched } = useRunOnDefault({
    active,
    availability,
    access,
    profileId,
    repoId,
    cloudSelected,
    setRecipeId,
    initialTargetFixed
  })
  const onSelectOrcaCloud = useCallback(() => {
    markTouched()
    setRecipeId?.(ORCA_CLOUD_RECIPE_ID)
  }, [markTouched, setRecipeId])

  // Start with setup still open: the dialog closes and the page takes over, prompt kept (N6).
  const openSetup = useCallback(
    (intentId: string) => {
      saveCloudStartDraft(profileId, {
        prompt,
        repoId,
        agent,
        target: 'orca-cloud',
        setupSessionId: null,
        createdAt: Date.now()
      })
      openCloudSetupPage({
        prompt,
        repoId,
        agent,
        availability,
        cloudOnlyRepo: cloudOnly.picked?.fullName ?? null,
        composer: composerSnapshot(),
        intentId
      })
      onClose?.()
    },
    [agent, availability, cloudOnly.picked, composerSnapshot, onClose, profileId, prompt, repoId]
  )

  // Reopened by the setup page: submit once the account and form are ready. Anything still open
  // (a race, a revoked grant) leaves the composer for the user, never a second trip on its own.
  // One Create press is one server create (P0): the intent is consumed here or nowhere.
  const stepsSettled = !steps.some((step) => step.state === 'loading' && step.id !== 'agent')
  useEffect(() => {
    if (!autoStartIntent || !cloudSelected || !createReady || !stepsSettled || setupNeeded) {
      return
    }
    if (consumeCloudCreateIntent(autoStartIntent)) {
      armCloudCreateIdempotency(autoStartIntent)
      onCreate()
    }
  }, [autoStartIntent, cloudSelected, createReady, onCreate, setupNeeded, stepsSettled])

  const onCloudPrimary = useCallback(
    () =>
      startCloudCreate({
        setupOpen: getCloudSetupPageRequest() !== null,
        setupNeeded,
        openSetup,
        create: () => onCreate()
      }),
    [onCreate, openSetup, setupNeeded]
  )

  const recordCreated = useCallback(() => {
    if (!repoId) {
      return
    }
    recordSuccessfulRunOn(profileId, repoId, cloudSelected ? 'orca-cloud' : 'local')
    if (!cloudSelected) {
      return
    }
    clearCloudStartDraft(profileId)
    // PC-5: no "Using sandbox hours" toast on start; hours live in billing (Neil: noise).
  }, [cloudSelected, profileId, repoId])

  const view = useMemo<CloudStartView | null>(
    () =>
      segment === 'hidden'
        ? null
        : {
            onSelectOrcaCloud,
            onUserPick: markTouched,
            cloudOnly,
            folderProject: cloudOnly.folderProject,
            wall,
            needsGitHubRepo: orcaCloudNeedsGitHubRepo({
              cloudSelected,
              folderProject: cloudOnly.folderProject,
              pickedRepo: cloudOnly.picked !== null,
              repoCount: cloudOnly.repos?.length ?? 0,
              githubProjectCount
            })
          },
    [cloudOnly, cloudSelected, githubProjectCount, markTouched, onSelectOrcaCloud, segment, wall]
  )
  if (!view || !cloudSelected) {
    return { view, onPrimary: null, recordCreated }
  }
  return { view, onPrimary: onCloudPrimary, recordCreated }
}
