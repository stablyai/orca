// Composer glue for "Start in Orca Cloud": derives the setup rows, names the primary button, runs
// setup instead of a build that billing would refuse, starts by itself once setup finishes, keeps
// the draft on disk, and remembers where each project last started.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
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
  CLOUD_SETUP_AUTO_START,
  getCloudSetupStarter,
  readCloudSetupSession,
  getCloudSetupSessionRevision,
  subscribeCloudSetupSessionRevision
} from '@/lib/orca-cloud/cloud-setup-session-seam'
import { readRunOnMemory, recordSuccessfulRunOn } from '@/lib/orca-cloud/run-on-memory'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { getCloudPrimaryLabel, setupActionFor } from './cloud-start-actions'
import {
  deriveCloudSetupSteps,
  getCloudPrimaryAction,
  getOpenSetupSteps,
  getOrcaCloudSegmentState,
  isCloudSetupPanelVisible,
  resolveDefaultRunOn,
  type CloudSetupStep
} from './cloud-start-model'

/** What the card renders: Run on's Orca Cloud segment, the setup panel and the fallback button. */
export type CloudStartView = {
  steps: CloudSetupStep[]
  panelVisible: boolean
  allSet: boolean
  onSelectOrcaCloud: () => void
  onUserPick: () => void
  /** Present while setup blocks a start: creates the same prompt on this computer. */
  onUseThisComputer?: () => void
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

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
  /** The composer was opened on an explicit target (⇧⌘N, a recovery): memory must not override it. */
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
  // Subscribing re-renders on each poll; the read itself is a cheap synchronous lookup.
  useSyncExternalStore(subscribeCloudSetupSessionRevision, getCloudSetupSessionRevision)
  const session = readCloudSetupSession(setupSessionId)
  const steps = useMemo(
    () => session?.steps ?? deriveCloudSetupSteps({ availability, access }),
    [access, availability, session?.steps]
  )
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

  // Remembered default, applied once per project until the user picks: never a blocked Orca Cloud.
  const touchedRef = useRef(initialTargetFixed)
  const appliedForRepo = useRef<string | null>(null)
  useEffect(() => {
    if (!active || touchedRef.current || appliedForRepo.current === repoId || !repoId) {
      return
    }
    if (segment === 'enabled' && access.state === 'loading') {
      return
    }
    appliedForRepo.current = repoId
    const memory = readRunOnMemory(profileId, repoId)
    const { target } = resolveDefaultRunOn({
      ...memory,
      cloudUsable:
        segment === 'enabled' && availability === 'offered' && access.state === 'entitled'
    })
    if (target === 'orca-cloud' && !cloudSelected) {
      setRecipeId?.(ORCA_CLOUD_RECIPE_ID)
    }
  }, [access.state, active, availability, cloudSelected, profileId, repoId, segment, setRecipeId])

  const onUserPick = useCallback(() => {
    touchedRef.current = true
  }, [])
  const onSelectOrcaCloud = useCallback(() => {
    touchedRef.current = true
    setRecipeId?.(ORCA_CLOUD_RECIPE_ID)
  }, [setRecipeId])

  // "Use this computer instead": switch, then submit once the switch has rendered.
  const localSubmitPendingRef = useRef(false)
  const useThisComputer = useCallback(() => {
    if (!localOption) {
      return
    }
    touchedRef.current = true
    localSubmitPendingRef.current = true
    setRecipeId?.(null)
    onHostChange?.(localOption.id)
  }, [localOption, onHostChange, setRecipeId])
  useEffect(() => {
    if (localSubmitPendingRef.current && !cloudSelected) {
      localSubmitPendingRef.current = false
      onCreate()
    }
  }, [cloudSelected, onCreate])

  // Setup started from this composer: when every required row is done, say "All set" and start.
  const [startedHere, setSetupStarted] = useState(false)
  const setupStarted = startedHere || restored
  const [allSet, setAllSet] = useState(false)
  useEffect(() => {
    const done = action === 'start' || session?.finished === true
    if (!setupStarted || !cloudSelected || !done || !CLOUD_SETUP_AUTO_START) {
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
    const startSession = getCloudSetupStarter()
    const fallback = setupActionFor(steps, access, availability)
    if (!startSession) {
      fallback?.()
      return
    }
    // One browser trip for every missing step; the session id rides on the draft across a quit.
    const needs = getOpenSetupSteps(steps).map((step) => step.id)
    void startSession({ repoId, needs })
      .then((opened) => {
        if (!opened) {
          fallback?.()
          return
        }
        setSetupSessionId(opened.sessionId)
        saveCloudStartDraft(profileId, { ...draft, setupSessionId: opened.sessionId })
      })
      .catch(() => fallback?.())
  }, [access, agent, availability, profileId, prompt, repoId, setupSessionId, steps])

  const recordCreated = useCallback(() => {
    if (!repoId) {
      return
    }
    recordSuccessfulRunOn(profileId, repoId, cloudSelected ? 'orca-cloud' : 'local')
    if (cloudSelected) {
      clearCloudStartDraft(profileId)
    }
  }, [cloudSelected, profileId, repoId])

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
    onUserPick,
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
