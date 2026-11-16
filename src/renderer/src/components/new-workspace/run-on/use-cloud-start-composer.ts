// Composer glue for Orca Cloud. Picking Orca Cloud changes nothing else in the
// dialog: Start either creates the workspace (everything is set up) or saves the draft, closes the
// dialog and opens the full-page setup, which starts the prompt by itself when done. Also: where
// each project last started, the remembered default and GitHub-only repositories.
import { useCallback, useEffect, useMemo, useRef } from 'react'
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
import type { OrcaCloudAvailability } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { ComposerModalData } from '../composer/composer-modal-data'
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

export type { CloudStartView } from './cloud-start-view'

export function useCloudStartComposer({
  active,
  availability,
  selectedRecipeId,
  setRecipeId,
  repoId,
  initialGitHubRepo = null,
  openRepoPicker = false,
  name,
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
  /** A GitHub-only repository to start with picked (`owner/repo`). */
  initialGitHubRepo?: string | null
  /** Open the Project picker once, after the dialog opens ("Choose another repository"). */
  openRepoPicker?: boolean
  /** The composer's name field (the setup page keeps it as its draft text). */
  name: string
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
  /** Closes the composer (setup moves to its page; or a cloud-only repository started). */
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
  const githubProjectCount = useAppStore((s) => s.repos.filter(isGitHubBackedProject).length)
  const selectOrcaCloudRef = useRef<() => void>(() => {})
  const cloudOnly = useCloudOnlyRepo({
    repoId,
    initialPicked: initialGitHubRepo,
    cloudSelected,
    cloudOffered: segment === 'enabled',
    signedIn: availability !== 'needs-sign-in' && access.state !== 'signed-out',
    // A repository granted on GitHub is picked for the person, so Run on follows it.
    onAutoPick: () => selectOrcaCloudRef.current()
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
  const setupNeeded = cloudSetupRequired(steps, {
    teamSwitch: switchTeam !== null
  })
  // An agent with no Orca Cloud account is still created with the workspace: its launch holds on
  // the pane's "Set up once" strip and never reaches the agent's own /login. In the
  // workspace the strip asks; away, the sidebar row's mark does (no toast follows the user).
  const onCreate = useCloudOnlyCreate({
    cloudOnly,
    createWorkspace,
    name,
    agent,
    profileId,
    onClose
  })

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
  useEffect(() => {
    selectOrcaCloudRef.current = onSelectOrcaCloud
  }, [onSelectOrcaCloud])

  // Start with setup still open: the dialog closes and the page takes over, prompt kept.
  const openSetup = useCallback(
    (intentId: string) => {
      saveCloudStartDraft(profileId, {
        prompt: name,
        repoId,
        agent,
        target: 'orca-cloud',
        setupSessionId: null,
        createdAt: Date.now()
      })
      openCloudSetupPage({
        prompt: name,
        repoId,
        agent,
        availability,
        cloudOnlyRepo: cloudOnly.picked?.fullName ?? null,
        composer: composerSnapshot(),
        intentId
      })
      onClose?.()
    },
    [agent, availability, cloudOnly.picked, composerSnapshot, name, onClose, profileId, repoId]
  )

  // Reopened by the setup page: submit once the account and form are ready. Anything still open
  // (a race, a revoked grant) leaves the composer for the user, never a second trip on its own.
  // One Create press is one server create: the intent is consumed here or nowhere.
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
    // No "Using sandbox hours" toast on start; hours live in billing.
  }, [cloudSelected, profileId, repoId])

  // A signal above 0 when the dialog mounts opens the picker once (useOpenOnSignal).
  const openRepoPickerSignal = openRepoPicker ? 1 : 0
  const view = useMemo<CloudStartView | null>(
    () =>
      segment === 'hidden'
        ? null
        : {
            onSelectOrcaCloud,
            onUserPick: markTouched,
            cloudOnly,
            openRepoPickerSignal,
            folderProject: cloudOnly.folderProject,
            needsGitHubRepo: orcaCloudNeedsGitHubRepo({
              cloudSelected,
              folderProject: cloudOnly.needsGitHubPick,
              remoteServerProject: cloudOnly.remoteServerProject,
              pickedRepo: cloudOnly.picked !== null,
              repoCount: cloudOnly.repos?.length ?? 0,
              githubProjectCount
            })
          },
    [
      cloudOnly,
      cloudSelected,
      githubProjectCount,
      markTouched,
      onSelectOrcaCloud,
      openRepoPickerSignal,
      segment
    ]
  )
  if (!view || !cloudSelected) {
    return { view, onPrimary: null, recordCreated }
  }
  return { view, onPrimary: onCloudPrimary, recordCreated }
}
