// Composer glue for "Start in Orca Cloud": the setup rows, the primary button's label and action,
// setup instead of a build that billing or GitHub would refuse, the start on its own once setup
// finishes (O4), the draft on disk (N7), and where each project last started (O5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { claimOrcaCloudTrial } from '@/components/billing/claim-trial'
import { translate } from '@/i18n/i18n'
import type {
  ProjectHostSetupOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import {
  clearCloudStartDraft,
  readCloudStartDraft,
  saveCloudStartDraft
} from '@/lib/orca-cloud/cloud-start-draft'
import {
  CLOUD_SETUP_ALL_SET_HOLD_MS,
  getCloudSetupStarter
} from '@/lib/orca-cloud/cloud-setup-session-seam'
import { recordSuccessfulRunOn } from '@/lib/orca-cloud/run-on-memory'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { getCloudPrimaryLabel, setupActionFor } from './cloud-start-actions'
import {
  getCloudPrimaryAction,
  getOpenSetupSteps,
  getOrcaCloudSegmentState,
  isCloudSetupPanelVisible
} from './cloud-start-model'
import { getOrcaCloudStartToast } from './orca-cloud-hours-copy'
import { useCloudStartSteps } from './use-cloud-start-steps'
import { useRunOnDefault } from './use-run-on-default'
import { prefersReducedMotion, type CloudStartView } from './cloud-start-view'

export type { CloudStartView } from './cloud-start-view'

export function useCloudStartComposer({
  active,
  availability,
  selectedRecipeId,
  setRecipeId,
  hostOptions,
  onHostChange,
  repoId,
  prompt,
  agent,
  initialTargetFixed,
  onCreate,
  accessOverride
}: {
  active: boolean
  availability: OrcaCloudAvailability
  selectedRecipeId: string | null
  setRecipeId: ((recipeId: string | null) => void) | undefined
  hostOptions: readonly ProjectHostSetupOption[]
  onHostChange: ((setupId: string) => void) | undefined
  repoId: string
  prompt: string
  agent: string | null
  /** The composer was opened on an explicit target (Landing card, a recovery). */
  initialTargetFixed: boolean
  onCreate: () => void
  /** Fixtures pin the account's access. */
  accessOverride?: OrcaCloudRunTargetAccess
}): {
  view: CloudStartView | null
  primaryActionLabel: string | null
  /** Replaces the plain create while Orca Cloud is selected. */
  onPrimary: (() => void) | null
  primaryDisabled: boolean
  /** False while the primary runs setup or the local fallback instead of a plain create. */
  primaryIsCreate: boolean
  /** Call from the composer's onCreated: only a successful start is remembered. */
  recordCreated: () => void
} {
  const profileId = useAppStore((s) => s.activeOrcaProfileId ?? null)
  const segment = getOrcaCloudSegmentState(availability)
  const cloudSelected = selectedRecipeId === ORCA_CLOUD_RECIPE_ID
  const fetched = useOrcaCloudRunTargetAccess(segment === 'enabled' && !accessOverride)
  const access = accessOverride ?? fetched
  const [startedSessionId, setSetupSessionId] = useState<string | null>(null)
  // A composer reopened after setup (e.g. the Checkout return) resumes its saved draft: derived,
  // not copied into state, so it is right on the first render.
  const restoredDraft = useMemo(
    () => (active && cloudSelected ? readCloudStartDraft(profileId) : null),
    [active, cloudSelected, profileId]
  )
  const [restoreDone, setRestoreDone] = useState(false)
  const restored = restoredDraft !== null && restoredDraft.repoId === repoId && !restoreDone
  const setupSessionId = startedSessionId ?? (restored ? restoredDraft.setupSessionId : null)
  const [startedHere, setSetupStarted] = useState(false)
  const setupStarted = startedHere || restored
  const setupStartedRef = useRef(setupStarted)
  const onCreateRef = useRef(onCreate)
  useEffect(() => {
    setupStartedRef.current = setupStarted
    onCreateRef.current = onCreate
  }, [onCreate, setupStarted])
  const { steps, session, openInstall } = useCloudStartSteps({
    availability,
    access,
    repoId,
    agent,
    cloudSelected,
    setupSessionId,
    onGranted: (repoName) => {
      // D2: an owner approved on GitHub. Setup already running starts by itself; otherwise ask.
      if (setupStartedRef.current) {
        return
      }
      toast.message(
        translate(
          'components.newWorkspace.cloudStart.githubGranted',
          'GitHub access granted for {{repo}}',
          {
            repo: repoName
          }
        ),
        {
          action: {
            label: getCloudPrimaryLabel('start'),
            onClick: () => onCreateRef.current()
          }
        }
      )
    }
  })
  const action = getCloudPrimaryAction(steps)
  const panelVisible = cloudSelected && isCloudSetupPanelVisible(steps)

  const localOption = useMemo(
    () =>
      hostOptions.find(
        (option): option is ReadyProjectHostSetupOption =>
          option.kind === 'ready' && option.hostId === LOCAL_EXECUTION_HOST_ID
      ) ?? null,
    [hostOptions]
  )

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

  // "Use this computer instead": switch, then submit once the switch has rendered.
  const localSubmitPendingRef = useRef(false)
  const useThisComputer = useCallback(() => {
    if (!localOption) {
      return
    }
    markTouched()
    localSubmitPendingRef.current = true
    setRecipeId?.(null)
    onHostChange?.(localOption.id)
  }, [localOption, markTouched, onHostChange, setRecipeId])
  useEffect(() => {
    if (localSubmitPendingRef.current && !cloudSelected) {
      localSubmitPendingRef.current = false
      onCreate()
    }
  }, [cloudSelected, onCreate])

  // Setup started from this composer (or its restored draft): when every required row is done,
  // hold "All set", then submit as if ⌘↵ had been pressed (O4).
  const [allSet, setAllSet] = useState(false)
  useEffect(() => {
    const done = action === 'start' || session?.finished === true
    if (!setupStarted || !cloudSelected || !done) {
      return
    }
    setAllSet(true)
    const timer = window.setTimeout(
      () => {
        setSetupStarted(false)
        setRestoreDone(true)
        setAllSet(false)
        onCreate()
      },
      prefersReducedMotion() ? 0 : CLOUD_SETUP_ALL_SET_HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [action, cloudSelected, onCreate, session?.finished, setupStarted])

  // The draft survives the browser trip and a quit; it is cleared once a workspace starts.
  const runSetup = useCallback(() => {
    const draft = {
      prompt,
      repoId,
      agent,
      target: 'orca-cloud' as const,
      setupSessionId,
      createdAt: Date.now()
    }
    saveCloudStartDraft(profileId, draft)
    setSetupStarted(true)
    const open = getOpenSetupSteps(steps)
    // D1: GitHub is the only thing missing, so its install page is the whole trip.
    if (open.length > 0 && open.every((step) => step.id === 'github' || step.id === 'agent')) {
      void openInstall()
      return
    }
    const startSession = getCloudSetupStarter()
    const fallback = setupActionFor(steps, access, availability)
    if (!startSession) {
      fallback?.()
      return
    }
    // One browser trip for every missing step; the session id rides on the draft across a quit.
    void startSession({ repoId, needs: open.map((step) => step.id) })
      .then((opened) => {
        if (!opened) {
          fallback?.()
          return
        }
        setSetupSessionId(opened.sessionId)
        saveCloudStartDraft(profileId, { ...draft, setupSessionId: opened.sessionId })
      })
      .catch(() => fallback?.())
  }, [access, agent, availability, openInstall, profileId, prompt, repoId, setupSessionId, steps])

  // B1: only the trial is missing. Claiming it is the whole setup; the billing cache then reads
  // entitled and the auto-start above submits. A personal account needs a team first: setup trip.
  const startTrial = useCallback(() => {
    setSetupStarted(true)
    void claimOrcaCloudTrial().then((result) => {
      if (result.status !== 'ok') {
        runSetup()
      }
    })
  }, [runSetup])

  const recordCreated = useCallback(() => {
    if (!repoId) {
      return
    }
    recordSuccessfulRunOn(profileId, repoId, cloudSelected ? 'orca-cloud' : 'local')
    if (!cloudSelected) {
      return
    }
    clearCloudStartDraft(profileId)
    // O4: the start always says which hours it spends.
    const message = getOrcaCloudStartToast(access, translate, navigator.language)
    if (message) {
      toast.message(message)
    }
  }, [access, cloudSelected, profileId, repoId])

  if (segment === 'hidden') {
    return {
      view: null,
      primaryActionLabel: null,
      onPrimary: null,
      primaryDisabled: false,
      primaryIsCreate: true,
      recordCreated
    }
  }
  const view: CloudStartView = {
    steps,
    panelVisible: panelVisible || allSet,
    allSet,
    onSelectOrcaCloud,
    onUserPick: markTouched,
    ...(panelVisible && localOption && action !== 'useThisComputer'
      ? { onUseThisComputer: useThisComputer }
      : {})
  }
  if (!cloudSelected) {
    return {
      view,
      primaryActionLabel: null,
      onPrimary: null,
      primaryDisabled: false,
      primaryIsCreate: true,
      recordCreated
    }
  }
  const onPrimary =
    action === 'start'
      ? onCreate
      : action === 'useThisComputer'
        ? useThisComputer
        : action === 'checking'
          ? () => undefined
          : action === 'startTrial'
            ? startTrial
            : runSetup
  return {
    view,
    primaryActionLabel: getCloudPrimaryLabel(allSet ? 'start' : action),
    onPrimary,
    primaryDisabled:
      action === 'checking' || allSet || (action === 'useThisComputer' && !localOption),
    primaryIsCreate: action === 'start',
    recordCreated
  }
}
