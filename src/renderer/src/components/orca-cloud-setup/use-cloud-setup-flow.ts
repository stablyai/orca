// The setup page's state and actions (composer-redo). It reuses the composer's setup plumbing: the
// rows from billing, the GitHub repository check and the agent accounts (useCloudStartSteps), the
// one-trip setup session (#255) with its deep-link return (#257), B2's team switch, and the
// tracker's error parsing (#260). Only the UI moved: from a card in the dialog to this page.
import { usePlanCatalog } from '@/components/billing/plans/use-plan-catalog'
import { cloudContactUrl } from './cloud-contact-url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { claimOrcaCloudTrial } from '@/components/billing/claim-trial'
import {
  invalidateOrcaCloudBilling,
  prefetchOrcaCloudBilling,
  useOrcaCloudRunTargetAccess
} from '@/components/new-workspace/orca-cloud-billing-cache'
import { setupActionFor } from '@/components/new-workspace/run-on/cloud-start-actions'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { useCloudStartSteps } from '@/components/new-workspace/run-on/use-cloud-start-steps'
import { useSwitchTeamSteps } from '@/components/new-workspace/cloud-setup/use-cloud-setup-tracker'
import { parseCloudSetupError } from '@/components/new-workspace/cloud-setup/cloud-setup-errors'
import {
  cloudSetupLinkSource,
  reopenCloudSetup
} from '@/components/new-workspace/cloud-setup/cloud-setup-tracker-actions'
import { getCloudSetupStarter } from '@/lib/orca-cloud/cloud-setup-session-seam'
import type { CloudSetupPageRequest } from '@/lib/orca-cloud/cloud-setup-page-store'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { reportCloudSetupProgress } from '@/lib/orca-cloud/cloud-setup-telemetry'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-run-target-access'
import {
  cloudSetupPageModel,
  sessionNeedsFrom,
  type CloudSetupPageModel
} from './cloud-setup-page-model'

/** Billing rows re-read this often while the page waits on a browser step (focus also re-reads). */
const BILLING_POLL_MS = 4_000

/**
 * Main's Orca Cloud availability for the project (needs-sign-in, needs-capability, offered), read
 * the way the composer reads it and re-read while the page waits, so a sign-in in the browser (or
 * the dev sign-in) moves the page on. Starts from the composer's answer at Start.
 */
function useLiveAvailability(
  repoId: string,
  initial: OrcaCloudAvailability,
  enabled: boolean
): { availability: OrcaCloudAvailability; reread: () => void } {
  const [availability, setAvailability] = useState(initial)
  // Bumped by "Try again": re-reads at once instead of on the next poll.
  const [generation, setGeneration] = useState(0)
  const reread = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const read = (): void => {
      void Promise.resolve()
        .then(() => window.api.ephemeralVm.listRecipes({ repoId }))
        .then((result) => {
          if (!cancelled && result.orcaCloud) {
            setAvailability(result.orcaCloud)
          }
        })
        .catch(() => undefined)
    }
    read()
    // Paused while the window is hidden; returning from the browser re-reads at once.
    const stop = installWindowVisibilityInterval({ run: read, intervalMs: BILLING_POLL_MS })
    window.addEventListener('focus', read)
    return () => {
      cancelled = true
      stop()
      window.removeEventListener('focus', read)
    }
  }, [enabled, repoId, generation])
  return { availability, reread }
}

export type CloudSetupFlow = CloudSetupPageModel & {
  /** True from the click until the browser opens or the trial answers. */
  busy: boolean
  /** This page's browser sign-in is pending: the page offers Cancel and keeps Reopen browser live. */
  signingIn: boolean
  /** The last sign-in stopped on its own (it timed out): "Sign-in didn’t finish. Try again." */
  signInDidNotFinish: boolean
  cancelSignIn: () => void
  /** Leaving setup (Back): cancels a sign-in this page started. */
  abandon: () => void
  /** The browser trip is open: the current step reads "Waiting for your browser". */
  inBrowser: boolean
  error: ReturnType<typeof parseCloudSetupError>
  canManageBilling: boolean
  teamAction: React.ReactNode | null
  continueInBrowser: () => void
  startTrial: () => void
  fixBilling: () => void
  installGitHub: () => void
  checkAgain: () => void
  /** Where "Contact us" goes when Orca Cloud isn't turned on for the team; null hides it. */
  contactUrl: string | null
  reopenBrowser: () => void
  /** "Copy link" beside Reopen browser: a fresh one-time setup link; null without a session. */
  reopenLink: ExternalLinkSource | null
  /** "Copy link" beside the GitHub step's button: the same install page, minted without opening. */
  installGitHubLink: ExternalLinkSource | null
}

export function useCloudSetupFlow(
  request: CloudSetupPageRequest,
  /** Fixtures pin the account; the app reads billing. */
  accessOverride?: OrcaCloudRunTargetAccess
): CloudSetupFlow {
  const fetched = useOrcaCloudRunTargetAccess(!accessOverride)
  const access = accessOverride ?? fetched
  const { availability, reread: rereadAvailability } = useLiveAvailability(
    request.repoId,
    request.availability,
    !accessOverride
  )
  const [sessionId, setSessionId] = useState<string | null>(null)
  // The step that was current when the browser opened. A setup session covers every step it was
  // opened for, so it waits on all of them; a single hop (GitHub install, billing) only on its own.
  const [browserStep, setBrowserStep] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const githubOverride = useMemo<CloudSetupStep | null>(
    () => (request.cloudOnlyRepo ? { id: 'github', state: 'done' } : null),
    [request.cloudOnlyRepo]
  )
  const {
    steps: rowSteps,
    session,
    openInstall,
    installLink
  } = useCloudStartSteps({
    availability,
    access,
    repoId: request.repoId,
    agent: request.agent,
    cloudSelected: true,
    setupSessionId: sessionId,
    githubOverride
  })
  const { steps, held: switchTeam } = useSwitchTeamSteps(rowSteps, !session)
  const model = cloudSetupPageModel(steps, { teamSwitch: switchTeam !== null })
  const error = useMemo(() => {
    const parsed = parseCloudSetupError(session?.error)
    return parsed && session?.teamName ? { ...parsed, teamName: session.teamName } : parsed
  }, [session?.error, session?.teamName])

  // Rows derived from billing tick on their own: re-read while a step is waiting elsewhere.
  const waiting = model.action !== 'done'
  useEffect(() => {
    if (!waiting || accessOverride) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => void prefetchOrcaCloudBilling(true),
      intervalMs: BILLING_POLL_MS
    })
  }, [accessOverride, waiting])

  useEffect(() => {
    if (sessionId) {
      reportCloudSetupProgress(sessionId, steps, error?.kind ?? null, { afterTrial: false })
    }
  }, [error?.kind, sessionId, steps])

  const stepsRef = useRef(steps)
  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  const markInBrowser = useCallback(
    () => setBrowserStep(cloudSetupPageModel(stepsRef.current).current?.id ?? null),
    []
  )

  const fallback = useCallback(
    () => setupActionFor(stepsRef.current, access, availability)?.(),
    [access, availability]
  )

  const runRef = useRef(0)
  const [startedSignIn, setStartedSignIn] = useState(false)
  const signInPending = useAppStore((state) => Boolean(state.orcaProfileSignInProgress))
  const signInTimedOut = useAppStore((state) => state.orcaProfileSignInEnd === 'timed-out')
  const signingIn = busy && startedSignIn && signInPending

  // One browser trip for everything still open from here (sign-in, team, trial or Checkout, GitHub).
  const continueInBrowser = useCallback(() => {
    const needs = sessionNeedsFrom(stepsRef.current)
    if (needs.length > 0 && needs.every((need) => need === 'github')) {
      markInBrowser()
      void openInstall()
      return
    }
    const start = getCloudSetupStarter()
    if (!start) {
      markInBrowser()
      fallback()
      return
    }
    // Each click is a new run. An older run that ends late (its sign-in was replaced or cancelled)
    // must not touch the page or open anything.
    const run = ++runRef.current
    const isCurrent = (): boolean => run === runRef.current
    setBusy(true)
    setBrowserStep(null)
    setStartedSignIn(cloudSetupPageModel(stepsRef.current).current?.id === 'account')
    void start({ repoId: request.repoId, needs })
      .then((opened) => {
        if (!isCurrent() || (opened && 'cancelled' in opened)) {
          // Cancelled, timed out or replaced: back to the step's own button; nothing reopens.
          return
        }
        markInBrowser()
        if (opened) {
          setSessionId(opened.sessionId)
        } else {
          fallback()
        }
      })
      .catch(() => {
        if (isCurrent()) {
          fallback()
        }
      })
      .finally(() => {
        if (isCurrent()) {
          setBusy(false)
          setStartedSignIn(false)
        }
      })
  }, [fallback, markInBrowser, openInstall, request.repoId])

  const cancelSignIn = useCallback(() => {
    void window.api.orcaProfiles.cancelSignIn().catch(() => {})
  }, [])

  const abandon = useCallback(() => {
    if (busy && startedSignIn) {
      // Back means "not now": the tab this page opened must not sign in behind the user's back.
      runRef.current++
      cancelSignIn()
    }
  }, [busy, cancelSignIn, startedSignIn])

  const startTrial = useCallback(() => {
    setBusy(true)
    void claimOrcaCloudTrial()
      .then((result) => {
        if (result.status !== 'ok') {
          // A personal account needs a team first, or the trial is gone: the browser covers it.
          continueInBrowser()
        }
      })
      .finally(() => setBusy(false))
  }, [continueInBrowser])

  const fixBilling = useCallback(() => {
    markInBrowser()
    invalidateOrcaCloudBilling({ refetchNow: false })
    fallback()
  }, [fallback, markInBrowser])

  const installGitHub = useCallback(() => {
    markInBrowser()
    void openInstall()
  }, [markInBrowser, openInstall])

  const checkAgain = useCallback(() => {
    void prefetchOrcaCloudBilling(true)
    // CAP-GATE: Orca Cloud may have been turned on for the team since; the page moves on by itself.
    rereadAvailability()
  }, [rereadAvailability])
  // "Contact us" (CAP-GATE): billing catalog's contact target, never a hard-coded address.
  const catalog = usePlanCatalog(model.action === 'capability-off')
  const contactUrl = cloudContactUrl(catalog.result)

  return {
    ...model,
    busy: busy && !signingIn,
    signingIn,
    signInDidNotFinish: !busy && signInTimedOut && model.action === 'sign-in',
    cancelSignIn,
    abandon,
    inBrowser: browserStep !== null && (sessionId !== null || model.current?.id === browserStep),
    error,
    canManageBilling: access.state === 'no-plan' ? access.canManageBilling : true,
    teamAction: switchTeam?.action ?? null,
    continueInBrowser,
    startTrial,
    fixBilling,
    installGitHub,
    checkAgain,
    contactUrl,
    reopenBrowser: () => void reopenCloudSetup(sessionId, continueInBrowser),
    reopenLink: cloudSetupLinkSource(sessionId),
    installGitHubLink: installLink
  }
}
