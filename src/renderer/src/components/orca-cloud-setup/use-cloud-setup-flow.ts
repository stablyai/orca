// The setup page's state and actions. It reuses the composer's setup plumbing: the
// rows from billing, the GitHub repository check and the agent accounts (useCloudStartSteps), the
// one-trip setup session with its deep-link return, the team switch, and the
// tracker's error parsing. Only the UI moved: from a card in the dialog to this page.
import { mintFirstClickLink } from '@/components/orca-sign-in-link'
import { usePlanCatalog } from '@/components/billing/use-plan-catalog'
import { cloudContactUrl } from './cloud-contact-url'
import { recheckCloudCapability } from './cloud-capability-recheck'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import {
  invalidateOrcaCloudBilling,
  pollOrcaCloudBilling,
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
import type { OrcaCloudAvailability } from '../../../../shared/workspace-setup/orca-yaml-hook-types'
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
  /** True from the click until the browser opens. */
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
  /** The setup session couldn't open and the step has no other fix: "Couldn't start setup". */
  startFailed: boolean
  error: ReturnType<typeof parseCloudSetupError>
  canManageBilling: boolean
  teamAction: React.ReactNode | null
  continueInBrowser: () => void
  /** "Copy link" on the first "Continue in browser": the same trip, started without the browser. */
  continueLink: ExternalLinkSource
  startTrial: () => void
  fixBilling: () => void
  installGitHub: () => void
  checkAgain: () => void
  /** Where "Contact us" goes when Orca Cloud isn't turned on for the team; null hides it. */
  contactUrl: string | null
  reopenBrowser: () => void
  /**
   * "Copy link" beside Reopen browser on the sign-in step: a fresh one-time setup link. Null on
   * other steps (plan, billing, GitHub App install) and without a session.
   */
  reopenLink: ExternalLinkSource | null
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
    openInstall
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
      // A tick joins a read still running: superseding it every 4 s would drop every read that
      // takes longer than that, and the page would never move on.
      run: () => void pollOrcaCloudBilling(),
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

  // Nothing opened and nothing else to try: the step keeps its button and says so.
  const [startFailed, setStartFailed] = useState(false)
  /**
   * The session couldn't open: run the step's own fix instead (sign-in, the plans dialog). It
   * opens its own UI, so the page doesn't claim to wait on a browser; with no fix, say it failed.
   */
  const fallback = useCallback(() => {
    const action = setupActionFor(stepsRef.current, access, availability)
    if (action) {
      action()
    } else {
      setStartFailed(true)
    }
  }, [access, availability])

  const runRef = useRef(0)
  const [startedSignIn, setStartedSignIn] = useState(false)
  const signInPending = useAppStore((state) => Boolean(state.orcaProfileSignInProgress))
  const signInTimedOut = useAppStore((state) => state.orcaProfileSignInEnd === 'timed-out')
  const signingIn = busy && startedSignIn && signInPending

  // One browser trip for everything still open from here (sign-in, team, trial or Checkout, GitHub).
  // `openBrowser: false` makes the same trip without the browser and hands
  // its link to `onUrl` (signed in: the session's; signed out: the sign-in publishes its own).
  const runBrowserTrip = useCallback(
    (copy?: { onUrl: (url: string | null) => void }) => {
      const needs = sessionNeedsFrom(stepsRef.current)
      if (needs.length > 0 && needs.every((need) => need === 'github')) {
        if (copy) {
          copy.onUrl(null)
          return
        }
        markInBrowser()
        void openInstall()
        return
      }
      setStartFailed(false)
      const start = getCloudSetupStarter()
      if (!start) {
        copy?.onUrl(null)
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
      void start({ repoId: request.repoId, needs, ...(copy ? { openBrowser: false } : {}) })
        .then((opened) => {
          if (!isCurrent() || (opened && 'cancelled' in opened)) {
            // Cancelled, timed out or replaced: back to the step's own button; nothing reopens.
            return
          }
          if (opened) {
            // Only once the session (and its browser tab) actually opened.
            markInBrowser()
            copy?.onUrl(opened.url ?? null)
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
    },
    [fallback, markInBrowser, openInstall, request.repoId]
  )
  const continueInBrowser = useCallback(() => runBrowserTrip(), [runBrowserTrip])
  const continueLink = useCallback(
    () => mintFirstClickLink((deliver) => runBrowserTrip({ onUrl: deliver })),
    [runBrowserTrip]
  )

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

  /** The console's billing page; the page waits on the browser only once it actually opened. */
  const openBillingInBrowser = useCallback(() => {
    setStartFailed(false)
    invalidateOrcaCloudBilling({ refetchNow: false })
    void openCloudConsole('billing').then((opened) => {
      if (opened) {
        markInBrowser()
      }
    })
  }, [markInBrowser])

  const startTrial = useCallback(() => {
    // The trial starts on the console's billing page for the active team ("Start free trial");
    // the billing poll moves the page on once it's granted. A personal account has no team yet:
    // the setup trip creates one and starts the trial there.
    if (!useAppStore.getState().orcaProfileAuthStatus?.cloud?.activeOrgId) {
      continueInBrowser()
      return
    }
    openBillingInBrowser()
  }, [continueInBrowser, openBillingInBrowser])

  // Hours, the spend cap and payment are all changed on the console's billing page.
  const fixBilling = openBillingInBrowser

  const installGitHub = useCallback(() => {
    markInBrowser()
    void openInstall()
  }, [markInBrowser, openInstall])

  const recheck = useCallback(
    (silent: boolean) => {
      // Orca Cloud may have been turned on for the team since (or the team started paying,
      // which auth counts as access); the page moves on by itself once the fresh capabilities land.
      void recheckCloudCapability({
        refreshAuth: () => useAppStore.getState().refreshCurrentOrcaProfileAuth({ silent }),
        prefetchBilling: () => prefetchOrcaCloudBilling(true),
        rereadAvailability
      })
    },
    [rereadAvailability]
  )
  // "Try again" says when auth can't be reached; the automatic check below stays quiet.
  const checkAgain = useCallback(() => recheck(false), [recheck])
  // The capabilities main read may predate the team's plan: ask auth once when the step first shows,
  // so a paying team never has to press "Try again" to get past it.
  const capabilityRechecked = useRef(false)
  useEffect(() => {
    if (model.action !== 'capability-off' || capabilityRechecked.current) {
      return
    }
    capabilityRechecked.current = true
    recheck(true)
  }, [model.action, recheck])
  // "Contact us": billing catalog's contact target, never a hard-coded address.
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
    startFailed: startFailed && !busy,
    error,
    canManageBilling: access.state === 'no-plan' ? access.canManageBilling : true,
    teamAction: switchTeam?.action ?? null,
    continueInBrowser,
    continueLink,
    startTrial,
    fixBilling,
    installGitHub,
    checkAgain,
    contactUrl,
    reopenBrowser: () => void reopenCloudSetup(sessionId, continueInBrowser),
    // Copy link is for sign-in pages only (pasted into an incognito window or another profile).
    reopenLink: signingIn || model.action === 'sign-in' ? cloudSetupLinkSource(sessionId) : null
  }
}
