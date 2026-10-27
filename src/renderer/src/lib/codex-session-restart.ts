import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import { translate } from '@/i18n/i18n'
import {
  getCodexAccountDisplayLabel,
  normalizeCodexAccountEmail
} from './codex-account-display-label'
import { isShellProcess } from '../../../shared/shell-process-detection'
import {
  isCodexForegroundProcess,
  isCodexRestartEligiblePane
} from './codex-pane-restart-eligibility'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../shared/tui-agent'

export type CodexPaneScanResult = {
  ptyId: string
  /** The pane may be shown a restart prompt (see isCodexRestartEligiblePane). */
  eligible: boolean
  /** Inspection failed or the handle was stale, so a later read may answer differently. */
  inconclusive: boolean
  /** Orca launched Codex in this tab, so a shell foreground can still be reattach settle. */
  launchedCodex: boolean
  notified: boolean
  laneKey: string
  laneSource: 'recorded' | 'derived'
}

/** Batch main’s recorded spawn lanes; absent old/web preload methods or registry failures must fall back to derivation rather than suppress notices. */
async function readRecordedCodexPaneLanes(
  ptyIds: readonly string[]
): Promise<Record<string, string>> {
  // Only daemon host spawns have registry entries; foreign lookups are guaranteed misses.
  const localPtyIds = ptyIds.filter((ptyId) => !isForeignMachineCodexPtyId(ptyId))
  if (localPtyIds.length === 0) {
    return {}
  }
  const listRecordedPaneLanes = window.api.codexAccounts.listRecordedPaneLanes
  // Older preloads lack this optional method; treat that as no records rather than scan failure.
  if (typeof listRecordedPaneLanes !== 'function') {
    return {}
  }
  return await listRecordedPaneLanes({ ptyIds: localPtyIds }).catch(() => ({}))
}

/** Fresh-scan shell readings only for Orca-launched Codex panes (#11064); cached shell flaps can lose the one-time notice. Only affirmative Codex evidence reverses ineligibility, not null or confirmed shell. */
async function isConfirmedCodexForegroundDespiteShellReading(
  ptyId: string,
  launchAgent: TuiAgent | undefined,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean> {
  if (
    launchAgent !== 'codex' ||
    isClientOnlyUnverifiableInspection(inspection) ||
    inspection.foregroundProcess === null ||
    !isShellProcess(inspection.foregroundProcess)
  ) {
    return false
  }
  const confirmed = await confirmRuntimeTerminalForegroundProcess(ptyId)
  return isCodexForegroundProcess(confirmed)
}

/** Filter lanes before process inspection: remote reads cost up to 15s and cannot justify a local-switch notice that swallows their input. */
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

  // Labels can remain fallback names; use live process evidence plus recorded launchAgent to find Codex.
  return Promise.all(
    panes.map(async ({ tab, ptyId }) => {
      const lane = resolveCodexPaneSelectionLane({
        state,
        tab,
        ptyId,
        recordedLaneKey: recordedLanes[ptyId]
      })
      if (!args.isLaneInScope(lane.laneKey)) {
        // Spawn lane is immutable; an out-of-lane answer is final and must not consume another retry.
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
      const inspection = await inspectRuntimeTerminalProcess(ptyId).then(
        (result) => result,
        // Why: one stale remote pane must not hide restart notices for other confirmed Codex panes.
        () => null
      )
      const eligible =
        inspection !== null &&
        (isCodexRestartEligiblePane({ inspection, launchAgent: tab.launchAgent }) ||
          (await isConfirmedCodexForegroundDespiteShellReading(ptyId, tab.launchAgent, inspection)))
      return {
        ptyId,
        eligible,
        inconclusive: inspection === null || isClientOnlyUnverifiableInspection(inspection),
        launchedCodex: tab.launchAgent === 'codex',
        notified: false,
        laneKey: lane.laneKey,
        laneSource: lane.source
      }
    })
  )
}

/** Prompt only panes affected by the written machine/runtime selection; unrelated panes would lose input to a needless notice. */
export async function markLiveCodexSessionsForRestart(args: {
  previousAccountLabel: string
  nextAccountLabel: string
  /** Keep account IDs: equal labels cannot distinguish switching back to the launch account from selecting a different account. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  target?: CodexAccountSelectionTarget | null
  /** Host whose roster the change wrote; never inferred from focus. */
  owner: RuntimeClientTarget
  /** Set when the change cleared the selection rather than pointing it somewhere. */
  clearsEveryWslDistro?: boolean
}): Promise<void> {
  const state = useAppStore.getState()
  const scans = await scanCodexPanes(state, {
    ptyIdFilter: null,
    isLaneInScope: getCodexAccountSwitchLaneMatcher({
      owner: args.owner,
      target: args.target,
      clearsEveryWslDistro: args.clearsEveryWslDistro
    })
  })
  const liveCodexSessionPtyIds = scans.filter((scan) => scan.eligible).map((scan) => scan.ptyId)
  if (liveCodexSessionPtyIds.length === 0) {
    return
  }

  const recordedLiveScans = scans.filter((scan) => scan.eligible && scan.laneSource === 'recorded')
  // Reauth can report null → A while the pane already launched on A; main’s per-PTY record decides staleness.
  const authoritativeStalePanes =
    recordedLiveScans.length === 0
      ? null
      : await window.api.codexAccounts
          .listStalePanes({ ptyIds: recordedLiveScans.map((scan) => scan.ptyId) })
          .catch(() => null)
  const authoritativeStaleByPtyId = authoritativeStalePanes
    ? new Map(authoritativeStalePanes.map((pane) => [pane.ptyId, pane]))
    : null
  if (authoritativeStaleByPtyId) {
    for (const scan of recordedLiveScans) {
      if (!authoritativeStaleByPtyId.has(scan.ptyId)) {
        useAppStore.getState().clearCodexRestartNotice(scan.ptyId)
      }
    }
  }

  useAppStore.getState().markCodexRestartNotices(
    scans.flatMap((scan) => {
      if (!scan.eligible) {
        return []
      }
      if (authoritativeStaleByPtyId && scan.laneSource === 'recorded') {
        const stalePane = authoritativeStaleByPtyId.get(scan.ptyId)
        if (!stalePane) {
          return []
        }
        return [
          {
            ptyId: scan.ptyId,
            previousAccountLabel: args.previousAccountLabel,
            nextAccountLabel: args.nextAccountLabel,
            previousAccountId: stalePane.launchAccountId,
            nextAccountId: stalePane.activeAccountId
          }
        ]
      }
      return [
        {
          ptyId: scan.ptyId,
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

/** Restore notices lost across app restart while daemon PTYs retain old account env. Return inspected outcomes for bounded retries; only local host/WSL spawns can appear in the registry, which checks each recorded lane. */
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
      // Main decides staleness by ID; colliding labels cannot answer the store’s identity checks.
      previousAccountId: pane.launchAccountId,
      nextAccountId: pane.activeAccountId
    }))
  )
  // Claim notified only if the store retained the notice; bind sweeps suppress claimed panes for the rest of the session.
  const notifiedPtyIds = new Set(noticedPtyIds)
  return scans.map((scan) => (notifiedPtyIds.has(scan.ptyId) ? { ...scan, notified: true } : scan))
}

// Same-email accounts need the same workspace or ID distinction as the switcher.
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
  const email = normalizeCodexAccountEmail(account.email)
  const sharesEmail = accounts.some(
    (entry) => entry.id !== account.id && normalizeCodexAccountEmail(entry.email) === email
  )
  return sharesEmail ? getCodexAccountDisplayLabel(account, accounts) : account.email
}

async function createCodexAccountLabelResolver(): Promise<(accountId: string | null) => string> {
  // Known account IDs still support prompts when roster/email lookup fails.
  const accounts = await window.api.codexAccounts.list().catch(() => null)
  return (accountId) => resolveCodexRestartPromptAccountLabel(accounts?.accounts ?? [], accountId)
}
