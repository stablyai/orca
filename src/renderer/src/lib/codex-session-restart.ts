import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import { translate } from '@/i18n/i18n'
import { isShellProcess } from '../../../shared/shell-process-detection'
import {
  isCodexForegroundProcess,
  isCodexRestartEligiblePane
} from './codex-pane-restart-eligibility'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { TuiAgent } from '../../../shared/tui-agent'

// Why: prompt integrations such as Starship can outlast the daemon's 300ms
// Codex fast-path timeout; account restarts must wait until the shell accepts input.
// Why launchAgent: pty:spawn runs the managed-auth readiness gate and Codex
// launch prep (project trust pre-mark) only for launchAgent 'codex', so without
// it a restart respawn could race the account handoff and record a launch
// account the pane does not actually read.
export const CODEX_ACCOUNT_RESTART_STARTUP = {
  command: 'codex',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex'
} as const

export type CodexPaneScanResult = {
  ptyId: string
  /** The pane may be shown a restart prompt (see isCodexRestartEligiblePane). */
  eligible: boolean
  /** Inspection failed or the handle was stale, so a later read may answer differently. */
  inconclusive: boolean
  /** Orca launched Codex in this tab, so a shell foreground can still be reattach settle. */
  launchedCodex: boolean
  /** A restart notice was raised for this pane by this scan. */
  notified: boolean
  /** The lane this pane was filtered on. */
  laneKey: string
  /** Whether that lane came from main's spawn record or the renderer's derivation. */
  laneSource: 'recorded' | 'derived'
}

/**
 * Asks main which lane each pane actually launched from.
 *
 * Why failure is silent: the answer only upgrades the derivation's accuracy, so
 * an older preload, a web client, or a missing registry must degrade to the
 * derivation rather than lose every pane's restart notice.
 */
async function readRecordedCodexPaneLanes(
  ptyIds: readonly string[]
): Promise<Record<string, string>> {
  // Why filtered: main only records daemon host spawns, so asking about a
  // remote or SSH pane is a guaranteed miss.
  const localPtyIds = ptyIds.filter((ptyId) => !isForeignMachineCodexPtyId(ptyId))
  if (localPtyIds.length === 0) {
    return {}
  }
  const listRecordedPaneLanes = window.api.codexAccounts.listRecordedPaneLanes
  // Why the shape check: a preload older than this handler has no such method,
  // and reaching that case must read as "no records", not as a scan failure.
  if (typeof listRecordedPaneLanes !== 'function') {
    return {}
  }
  return await listRecordedPaneLanes({ ptyIds: localPtyIds }).catch(() => ({}))
}

/**
 * Re-checks a shell reading with a fresh, uncached scan before trusting it.
 *
 * Why: the cached foreground read can flap to the pane's shell for a live Codex
 * session (#11064), and a spurious shell here silently skips the restart card —
 * no error, no retry. Mirrors main's terminalHasShellForegroundProcess, which
 * already refuses to conclude "agent done" from an unconfirmed shell reading.
 * Gated to Orca-launched Codex panes so an account switch never spends the
 * expensive fresh scan on ordinary shell terminals, and only an affirmative
 * codex answer flips the decision: a confirmed shell (user exited Codex) and a
 * null (scan failed or unsupported) both keep today's ineligible outcome.
 */
async function isConfirmedCodexForegroundDespiteShellReading(
  state: AppState,
  ptyId: string,
  launchAgent: TuiAgent | undefined,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean> {
  if (
    launchAgent !== 'codex' ||
    inspection.unavailable === true ||
    inspection.foregroundProcess === null ||
    !isShellProcess(inspection.foregroundProcess)
  ) {
    return false
  }
  const confirmed = await confirmRuntimeTerminalForegroundProcess(state.settings, ptyId)
  return isCodexForegroundProcess(confirmed)
}

/**
 * Reports which panes are running Codex, skipping any outside the caller's lane.
 *
 * Why the lane filter runs BEFORE inspection rather than after: an out-of-lane
 * answer cannot change the outcome, and the inspection is not free — a pane on a
 * relay environment costs a 15s-timeout RPC per look. Skipping first is also
 * what keeps a restart notice (which drops every keystroke in the pane) off a
 * remote Codex session that no local account change can possibly strand.
 */
async function scanCodexPanes(
  state: AppState,
  args: {
    ptyIdFilter: ReadonlySet<string> | null
    isLaneInScope: (laneKey: string) => boolean
  }
): Promise<CodexPaneScanResult[]> {
  const panes = Object.values(state.tabsByWorktree)
    .flat()
    .flatMap((tab) =>
      (state.ptyIdsByTabId[tab.id] ?? [])
        .filter((ptyId) => args.ptyIdFilter === null || args.ptyIdFilter.has(ptyId))
        .map((ptyId) => ({ tab, ptyId }))
    )
  const recordedLanes = await readRecordedCodexPaneLanes(panes.map((pane) => pane.ptyId))

  // Why: Codex sessions are not reliably discoverable from tab labels. Tabs keep
  // fallback names until a CLI emits an OSC title, and Codex does not always do
  // that. The live process tree plus the tab's recorded launchAgent are the
  // stable evidence that this pane is running Codex.
  return Promise.all(
    panes.map(async ({ tab, ptyId }) => {
      const lane = resolveCodexPaneSelectionLane({
        state,
        tab,
        ptyId,
        recordedLaneKey: recordedLanes[ptyId]
      })
      if (!args.isLaneInScope(lane.laneKey)) {
        // Why not inconclusive: a pane's lane is fixed at spawn, so this is a
        // final answer and the sweep must not spend a retry rung re-asking.
        return {
          ptyId,
          eligible: false,
          inconclusive: false,
          launchedCodex: false,
          notified: false,
          laneKey: lane.laneKey,
          laneSource: lane.source
        }
      }
      const inspection = await inspectRuntimeTerminalProcess(state.settings, ptyId).then(
        (result) => result,
        // Why: one stale remote pane must not hide restart notices for other confirmed Codex panes.
        () => null
      )
      const eligible =
        inspection !== null &&
        (isCodexRestartEligiblePane({ inspection, launchAgent: tab.launchAgent }) ||
          (await isConfirmedCodexForegroundDespiteShellReading(
            state,
            ptyId,
            tab.launchAgent,
            inspection
          )))
      return {
        ptyId,
        eligible,
        inconclusive: inspection === null || inspection.unavailable === true,
        launchedCodex: tab.launchAgent === 'codex',
        notified: false,
        laneKey: lane.laneKey,
        laneSource: lane.source
      }
    })
  )
}

/**
 * Prompts the panes a just-applied account change stranded.
 *
 * `target` names the selection slot the change wrote. Panes outside that lane —
 * a WSL pane on a host switch, or anything running on a relay/SSH machine —
 * never had this account injected, so a notice there is pure damage: it mutes a
 * terminal that is working correctly.
 */
export async function markLiveCodexSessionsForRestart(args: {
  previousAccountLabel: string
  nextAccountLabel: string
  /** Ids behind the labels. Two accounts can share a label, so without these the
   *  store cannot tell a switch back to the launch account from a switch to a
   *  different account that merely reads the same. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  target?: CodexAccountSelectionTarget | null
  /** Set when the change cleared the selection rather than pointing it somewhere. */
  clearsEveryWslDistro?: boolean
}): Promise<void> {
  const state = useAppStore.getState()
  const scans = await scanCodexPanes(state, {
    ptyIdFilter: null,
    isLaneInScope: getCodexAccountSwitchLaneMatcher({
      settings: state.settings,
      target: args.target,
      clearsEveryWslDistro: args.clearsEveryWslDistro
    })
  })
  const liveCodexSessionPtyIds = scans.filter((scan) => scan.eligible).map((scan) => scan.ptyId)
  if (liveCodexSessionPtyIds.length === 0) {
    return
  }

  const currentState = useAppStore.getState()
  const restoredRouteNoticePtyIds = liveCodexSessionPtyIds.filter(
    (ptyId) => currentState.codexRestartNoticeByPtyId[ptyId]?.homeRouteChanged === true
  )
  const restoredRouteNoticePtyIdSet = new Set(restoredRouteNoticePtyIds)
  const authoritativeStalePanes =
    restoredRouteNoticePtyIds.length === 0
      ? null
      : await window.api.codexAccounts
          .listStalePanes({ ptyIds: restoredRouteNoticePtyIds })
          .catch(() => null)
  const authoritativeStaleByPtyId = authoritativeStalePanes
    ? new Map(authoritativeStalePanes.map((pane) => [pane.ptyId, pane]))
    : null
  if (authoritativeStaleByPtyId) {
    for (const ptyId of restoredRouteNoticePtyIds) {
      if (!authoritativeStaleByPtyId.has(ptyId)) {
        useAppStore.getState().clearCodexRestartNotice(ptyId)
      }
    }
  }

  useAppStore.getState().markCodexRestartNotices(
    liveCodexSessionPtyIds.flatMap((ptyId) => {
      if (authoritativeStaleByPtyId && restoredRouteNoticePtyIdSet.has(ptyId)) {
        const stalePane = authoritativeStaleByPtyId.get(ptyId)
        if (!stalePane) {
          return []
        }
        return [
          {
            ptyId,
            previousAccountLabel: args.previousAccountLabel,
            nextAccountLabel: args.nextAccountLabel,
            previousAccountId: stalePane.launchAccountId,
            nextAccountId: stalePane.activeAccountId,
            homeRouteChanged: stalePane.reason === 'home-route-change'
          }
        ]
      }
      return [
        {
          ptyId,
          previousAccountLabel: args.previousAccountLabel,
          nextAccountLabel: args.nextAccountLabel,
          ...(args.previousAccountId === undefined
            ? {}
            : { previousAccountId: args.previousAccountId }),
          ...(args.nextAccountId === undefined ? {} : { nextAccountId: args.nextAccountId })
        }
      ]
    })
  )
}

/**
 * Re-raises restart prompts for panes that outlived the app.
 *
 * Why: restart notices are renderer state, but the shells they describe live in
 * the PTY daemon and survive a full app restart with the old account still
 * baked into their environment. Without this, quitting Orca before restarting a
 * stale pane silently strands it on the previous account forever.
 *
 * Returns one result per inspected pane so the bind-driven sweep can tell an
 * answered pane from one whose PTY has not reported a usable process yet.
 *
 * Scoped to the local host/WSL lanes because the pane-account registry only
 * records daemon host spawns: a relay or SSH pane can never be listed stale, so
 * inspecting one is a guaranteed-fruitless RPC. listStalePanes then does the
 * host-vs-WSL check itself, against each pane's own recorded lane.
 */
export async function markRestoredStaleCodexSessionsForRestart(args?: {
  ptyIds?: readonly string[]
}): Promise<CodexPaneScanResult[]> {
  const state = useAppStore.getState()
  const scans = await scanCodexPanes(state, {
    ptyIdFilter: args?.ptyIds ? new Set(args.ptyIds) : null,
    isLaneInScope: isLocalCodexSelectionLaneKey
  })
  const liveCodexSessionPtyIds = scans.filter((scan) => scan.eligible).map((scan) => scan.ptyId)
  if (liveCodexSessionPtyIds.length === 0) {
    return scans
  }
  const stalePanes = await window.api.codexAccounts.listStalePanes({
    ptyIds: liveCodexSessionPtyIds
  })
  if (stalePanes.length === 0) {
    return scans
  }

  const resolveAccountLabel = await createCodexAccountLabelResolver()
  const noticedPtyIds = useAppStore.getState().markCodexRestartNotices(
    stalePanes.map((pane) => ({
      ptyId: pane.ptyId,
      previousAccountLabel: resolveAccountLabel(pane.launchAccountId),
      nextAccountLabel: resolveAccountLabel(pane.activeAccountId),
      // Why the ids: main decided staleness by id, and the labels can collide.
      // Passing only labels hands the store a question it cannot answer.
      previousAccountId: pane.launchAccountId,
      nextAccountId: pane.activeAccountId,
      ...(pane.reason === 'home-route-change' ? { homeRouteChanged: true as const } : {})
    }))
  )
  // Why not every stale pane: the bind sweep suppresses a "notified" pane for the
  // rest of the session, so a pane whose notice the store dropped must not claim
  // one — that trades a missing prompt for a permanently missing prompt.
  const notifiedPtyIds = new Set(noticedPtyIds)
  return scans.map((scan) => (notifiedPtyIds.has(scan.ptyId) ? { ...scan, notified: true } : scan))
}

/**
 * Names an account for the restart prompt.
 *
 * Why the collision check: one OpenAI login added under two ChatGPT workspaces
 * gives both accounts the same email, and "switch from x@y to x@y" names
 * neither. The workspace is appended only when it is what tells them apart.
 */
export function resolveCodexRestartPromptAccountLabel(
  accounts: readonly { id: string; email: string; workspaceLabel?: string | null }[],
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return translate('auto.lib.codex.session.restart.4bd4a3a9c7', 'System default')
  }
  const account = accounts.find((entry) => entry.id === accountId)
  if (!account) {
    return translate('auto.lib.codex.session.restart.9f0b1c2d3e', 'Codex account')
  }
  const sharesEmail = accounts.some(
    (entry) => entry.id !== account.id && entry.email === account.email
  )
  return sharesEmail && account.workspaceLabel
    ? `${account.email} (${account.workspaceLabel})`
    : account.email
}

async function createCodexAccountLabelResolver(): Promise<(accountId: string | null) => string> {
  // Why: a failed roster read still yields usable prompts — the account ids are
  // already known, only their friendly emails are missing.
  const accounts = await window.api.codexAccounts.list().catch(() => null)
  return (accountId) => resolveCodexRestartPromptAccountLabel(accounts?.accounts ?? [], accountId)
}
