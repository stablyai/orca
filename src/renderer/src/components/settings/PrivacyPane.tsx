// Privacy pane — the permanent surface for the telemetry opt-in toggle.
// Two responsibilities:
//   1. Flip `optedIn` when the user toggles the switch. All renderer-
//      initiated opt-in flips route through `window.api.telemetrySetOptIn`;
//      main derives the `via` tag and fires `telemetry_opted_in` /
//      `telemetry_opted_out`.
//   2. Render the correct "blocked by X" helper text when an environment
//      variable (DO_NOT_TRACK, ORCA_TELEMETRY_DISABLED) or CI presence
//      disables transmission at runtime. Env vars are main-side process
//      state, so the pane reads effective consent via
//      `telemetry:getConsentState`.
//
// The toggle is NOT gated while the existing-user notice is pending — the
// whole point of the pane is to let the user flip consent, and disabling
// it would create a chicken-and-egg where the notice pushes the user at
// Settings and the pane points back at the notice. Flipping the toggle
// moves `optedIn` off `null`, which un-mounts `TelemetryFirstLaunchSurface`
// on its own — so "toggle in Settings" IS a way to dismiss the notice.
//
// Structural note: the pane mimics NotificationsPane / DeveloperPermissionsPane
// — a small toggle-heavy surface with inline helper text. A single-row
// "toggle + subtext" layout keeps this file UI-only; `captureException` /
// `$identify` patterns were considered and rejected in the telemetry
// Decision Record and are intentionally not used here.

import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import type { TelemetryConsentState } from '../../../../shared/telemetry-consent-types'
import { Label } from '../ui/label'
import { PRIVACY_URL, getConsentState, setOptIn as telemetrySetOptIn } from '../../lib/telemetry'
import { useAppStore } from '../../store'

// Pure helpers, exported for direct test coverage. The component's
// useEffect cannot be exercised in the node-env vitest harness (no DOM,
// no act()), so we keep the blocked-state decision and the env-var name
// mapping as plain functions that tests can call without rendering.
export type EnvBlockedReason = 'do_not_track' | 'orca_disabled' | 'ci'

// Reasons the toggle is read-only. Only env/CI overrides block the toggle:
// they persist until the operator unsets the variable and relaunches, so
// the user's flip cannot take effect until then. The existing-user notice
// is NOT a blocked reason — flipping the toggle is one of the valid ways
// to resolve it.
export type BlockedReason = { kind: 'env'; reason: EnvBlockedReason }

export function isEnvBlocked(consent: TelemetryConsentState | null): consent is {
  effective: 'disabled'
  reason: EnvBlockedReason
} {
  return (
    consent?.effective === 'disabled' &&
    (consent.reason === 'do_not_track' ||
      consent.reason === 'orca_disabled' ||
      consent.reason === 'ci')
  )
}

export function envVarNameForReason(reason: EnvBlockedReason): string {
  if (reason === 'do_not_track') {
    return 'DO_NOT_TRACK'
  }
  if (reason === 'orca_disabled') {
    return 'ORCA_TELEMETRY_DISABLED'
  }
  return 'CI'
}

// Compute the reason the toggle should be inert, if any. Only env-var /
// CI overrides block the toggle — they persist until the operator unsets
// the variable and relaunches. The existing-user notice does not gate the
// toggle; flipping it is a valid way to resolve the notice.
//
// Exported for test coverage. The component renders helper text by
// pattern-matching the returned shape.
export function computeBlockedReason(consent: TelemetryConsentState | null): BlockedReason | null {
  if (isEnvBlocked(consent)) {
    return { kind: 'env', reason: consent.reason }
  }
  return null
}

// Stable id wired from the switch's `aria-describedby` to the blocked-state
// helper text below it. Without this, screen-reader users hear "switch,
// disabled" with no explanation of why the toggle is inert.
const PRIVACY_PANE_BLOCKED_HELPER_ID = 'privacy-pane-blocked-helper'

type PrivacyPaneProps = {
  settings: GlobalSettings
}

export function PrivacyPane({ settings }: PrivacyPaneProps): React.JSX.Element {
  const [consent, setConsent] = useState<TelemetryConsentState | null>(null)
  // Double-click guard. Main's `setOptIn` has no idempotence check; without
  // this guard a fast double-click would fire two
  // `telemetry_opted_{in,out}` events for one user intent. The handler
  // derives `nextOptedIn` from `toggleChecked`, which is computed from
  // `settings.telemetry?.optedIn`. Main's `telemetry:setOptIn` handler
  // intentionally does NOT broadcast `settings:changed` on telemetry writes
  // (telemetry writes stay silent at the settings-event layer so unrelated
  // subscribers never re-render on a telemetry flip), so after
  // `telemetrySetOptIn` resolves we explicitly call
  // `fetchSettings()` to sync the renderer store. This ensures the next
  // click sees the updated `toggleChecked` and does not re-fire the same
  // opt-{in,out} intent against the user's already-persisted choice; the
  // `inFlight` flag guards only the window between the click and that
  // refetch completing.
  const [inFlight, setInFlight] = useState(false)
  const fetchSettings = useAppStore((s) => s.fetchSettings)

  // Pull the effective consent state on mount and again when the user
  // interacts with the toggle — env-var status does not change within a
  // session, but a toggle flip changes the `user_opt_out` branch so the
  // helper text needs to refresh. Polling is not needed; the pane is
  // self-contained and the env-var branch is stable for the session.
  useEffect(() => {
    let stale = false
    void getConsentState().then((state) => {
      if (!stale) {
        setConsent(state)
      }
    })
    return () => {
      stale = true
    }
  }, [settings.telemetry?.optedIn])

  const blocked = computeBlockedReason(consent)

  // Display the user's stored preference, not the effective state. An env
  // var blocks transmission without overwriting the persisted preference
  // (consent.ts:6-8 is explicit about this), so the toggle should still
  // reflect "what the user chose" and the helper text explains why it's
  // inactive. `optedIn === null` (existing user pre-banner) reads as off
  // because no events are transmitting.
  const toggleChecked = settings.telemetry?.optedIn === true

  const handleToggle = async (): Promise<void> => {
    if (blocked || inFlight) {
      // Belt-and-suspenders: the button is disabled when env/CI overrides
      // block transmission, but the click handler is the single source of
      // truth for "did the user actually flip consent?" If a CSS or a11y
      // bug ever makes the disabled button clickable, we must not route a
      // flip through `telemetrySetOptIn` against an env-blocked state. The
      // `inFlight` arm additionally suppresses duplicate sends while a
      // previous flip is still round-tripping through IPC.
      return
    }
    setInFlight(true)
    const nextOptedIn = !toggleChecked
    // Route through `telemetrySetOptIn` (NOT `settings:set` alone).
    // `settings:set` persists the flip but skips `telemetry_opted_in/out`
    // emission and the PostHog SDK's in-memory optIn / optOut flip. Main's
    // `setOptIn` writes the preference, emits the event with
    // `via='settings'`, and flips the SDK flag — all in the right order
    // (opt-out event BEFORE posthog.optOut).
    try {
      await telemetrySetOptIn(nextOptedIn)
      // Why: main's telemetry:setOptIn handler intentionally does NOT
      // broadcast `settings:changed` — the invariant is that telemetry
      // writes stay silent at the settings-event layer. But the Privacy
      // pane derives `toggleChecked` from `settings.telemetry?.optedIn`,
      // so without an explicit refresh the toggle would stay stuck on its
      // pre-flip value. Refetch here so the next click sees the updated
      // state and does not re-fire the same opt-{in,out} event against
      // the user's already-persisted choice.
      await fetchSettings()
    } finally {
      setInFlight(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 px-1 py-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            <Label>Share anonymous usage data</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Help us figure out what to build next. Orca sends anonymous counts of which features you
            use and where things break — no file contents, prompts, terminal output, branch names,
            or anything that identifies you.{' '}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => void window.api.shell.openUrl(PRIVACY_URL)}
            >
              Privacy policy
            </button>
            .
          </p>
        </div>
        <button
          role="switch"
          aria-checked={toggleChecked}
          aria-label="Share anonymous usage data"
          aria-describedby={blocked ? PRIVACY_PANE_BLOCKED_HELPER_ID : undefined}
          disabled={blocked !== null || inFlight}
          onClick={handleToggle}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
            toggleChecked ? 'bg-foreground' : 'bg-muted-foreground/30'
          } ${blocked !== null || inFlight ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              toggleChecked ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {blocked ? <BlockedHelper blocked={blocked} id={PRIVACY_PANE_BLOCKED_HELPER_ID} /> : null}
    </div>
  )
}

// Per-reason copy for the env/CI blocked states. The pane is accessible
// only once the app boots past CI detection, so `ci` is rare on a
// desktop install — but it's included for symmetry with the resolver.
function BlockedHelper({ blocked, id }: { blocked: BlockedReason; id: string }): React.JSX.Element {
  return (
    <div id={id} className="px-1 pb-2 text-xs text-muted-foreground">
      <EnvHelperBody reason={blocked.reason} />
    </div>
  )
}

function EnvHelperBody({ reason }: { reason: EnvBlockedReason }): React.JSX.Element {
  if (reason === 'ci') {
    return (
      <p>
        Telemetry is disabled because a CI environment variable is set. Unset it and restart to
        re-enable.
      </p>
    )
  }
  const varName = envVarNameForReason(reason)
  return (
    <p>
      Telemetry is disabled by the{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{varName}</code>{' '}
      environment variable. Unset it and restart to re-enable.
    </p>
  )
}
