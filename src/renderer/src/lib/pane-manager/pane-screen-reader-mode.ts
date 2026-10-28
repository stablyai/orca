import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type ScreenReaderModePreference = GlobalSettings['terminalScreenReaderMode']

/** The panes one host owns, read fresh: a host's pane set changes under it. */
type PaneSource = () => Iterable<Terminal>

/** The slice of the preload UI bridge this needs, so a missing bridge is a type, not a crash. */
type AccessibilitySupportApi = {
  isAccessibilitySupportEnabled: () => Promise<boolean>
  onAccessibilitySupportChanged: (callback: (enabled: boolean) => void) => () => void
}

/**
 * Whether xterm should keep the DOM an assistive client reads.
 *
 * Why a setting at all, when the OS already answers: Electron reports the accessibility-support flag
 * on macOS and Windows only, so `'auto'` alone would leave Linux users with no way to turn this on.
 * And on macOS the flag goes true for *any* accessibility client, not only screen readers, so
 * somebody running an unrelated utility needs a way to turn it off. `'auto'` is right for almost
 * everyone; the override exists for the two ends it cannot reach.
 */
export function resolveScreenReaderMode(
  preference: ScreenReaderModePreference | undefined,
  accessibilitySupportEnabled: boolean
): boolean {
  if (preference === 'on') {
    return true
  }
  if (preference === 'off') {
    return false
  }
  // Everything else follows the platform: `auto`, a profile written before this option existed, and
  // one written by a build that spells it differently. Settings are read off disk, so the union
  // describes this build rather than the file -- and `screenReaderMode` is a boolean, so a value
  // this function did not recognise must not leave as `undefined`. Written as branches rather than
  // a switch because an exhaustive switch cannot carry the default arm that would say so.
  return accessibilitySupportEnabled
}

// Why module-scoped: panes are minted continuously — splits, restored layouts, agent tabs — and each
// is built from buildDefaultTerminalOptions() before any effect can reach it. Holding the resolved
// answer here lets a new pane open in the right mode instead of announcing nothing until the next
// apply, and lets the two inputs arrive in either order.
let preference: ScreenReaderModePreference = 'auto'
let accessibilitySupportEnabled = false

const sources = new Set<PaneSource>()
let release: (() => void) | null = null

export function isScreenReaderModeEnabled(): boolean {
  return resolveScreenReaderMode(preference, accessibilitySupportEnabled)
}

/**
 * Mirrors the resolved mode onto a set of panes.
 *
 * Why: xterm builds the DOM a screen reader actually reads — one node per visible row, rebuilt on
 * scroll — only while screenReaderMode is on, and nothing in Orca ever turned it on, so pane output
 * reached no assistive client at all.
 */
export function applyScreenReaderMode(terminals: Iterable<Terminal>, enabled: boolean): void {
  for (const terminal of terminals) {
    // Why value-gated: writing screenReaderMode rebuilds the accessibility tree from scratch, so a
    // no-op re-apply would yank the rows out from under a screen reader mid-read.
    if (terminal.options.screenReaderMode !== enabled) {
      terminal.options.screenReaderMode = enabled
    }
  }
}

function publish(): void {
  const enabled = isScreenReaderModeEnabled()
  for (const source of sources) {
    applyScreenReaderMode(source(), enabled)
  }
}

/** The user's choice changed. No-op when it resolves to what the panes already have. */
export function setScreenReaderModePreference(next: ScreenReaderModePreference | undefined): void {
  const resolved = next ?? 'auto'
  if (resolved === preference) {
    return
  }
  preference = resolved
  publish()
}

/**
 * Registers a pane host and returns its removal.
 *
 * Why one subscription rather than one per host: every retained tab mounts its own pane host, and a
 * listener each would put twenty on a single channel for twenty tabs — past Node's warning
 * threshold, and against the per-pane listener budget this package already pins. The first host in
 * opens the subscription and seeds from the getter; the last one out closes it.
 *
 * @param ui the preload UI bridge, or undefined where none is installed — the web client and the
 *   test renderer both mount panes without one, and neither has an accessibility flag to read.
 */
export function watchScreenReaderMode(
  source: PaneSource,
  ui: AccessibilitySupportApi | undefined
): () => void {
  sources.add(source)
  // A host that mounts after either input arrived catches up without another round trip.
  applyScreenReaderMode(source(), isScreenReaderModeEnabled())
  if (!release && ui) {
    let cancelled = false
    let pushed = false
    const unsubscribe = ui.onAccessibilitySupportChanged((enabled) => {
      pushed = true
      accessibilitySupportEnabled = enabled
      publish()
    })
    // Why the getter too: panes mount long after main's accessibility-support-changed fired, the
    // same way WindowControls seeds its maximize icon rather than waiting for a transition.
    //
    // Why a push cancels it: the seed is a round trip, and its answer is whatever was true when it
    // was answered. A push that lands first is newer, so letting the seed resolve over it would
    // put the panes back to a value the platform has already left -- and with the flag no longer
    // moving there is no further event to correct it. The seed exists to cover the case where
    // nothing is pushed at all; once something is, it has nothing left to say.
    void ui.isAccessibilitySupportEnabled().then((enabled) => {
      if (cancelled || pushed) {
        return
      }
      accessibilitySupportEnabled = enabled
      publish()
    })
    release = (): void => {
      cancelled = true
      unsubscribe()
    }
  }
  return (): void => {
    sources.delete(source)
    if (sources.size === 0) {
      release?.()
      release = null
      // Why forget it: with the subscription closed nothing is telling us when the client detaches,
      // so a remembered `true` would seed the next pane from a fact we no longer hold. The next host
      // in re-seeds from the getter. The user's own choice is not forgotten -- that is a setting.
      accessibilitySupportEnabled = false
    }
  }
}
