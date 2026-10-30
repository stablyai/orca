import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
import type { PaneForegroundAgentTracker } from '../pane-foreground-agent-tracker-contract'
import { useAppStore } from '@/store'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { collectLeafIds } from '../../../../../shared/terminal-pane-layout-tree'
import { captureTerminalFactSubject } from '../terminal-fact-subject'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { TerminalFactSubject } from '../terminal-fact-subject'
import type { PaneLaunchAgentPaneSlice } from './pane-launch-agent-candidate'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

export type TerminalForegroundServices = {
  paneKey: string
  worktreeId: string
  tabId: string
  runtimeEnvironmentId?: string | null
  cwd: string
  startup: PaneLaunchAgentPaneSlice['startup']
  isLive?: () => boolean
  execution?: object
  endpoint?: string
  executionHost?: string
  getInputGeneration?: () => number
  getPtyId: () => string | null
  getExpectedIncarnationId: () => string | null
  isVisible: () => boolean
  observeForegroundAgentProcess: (process: RecognizedAgentProcess) => void
  onConfirmedShellForeground: (reason: 'command-finished' | 'visible-pty' | 'process-exit') => void
  flushPendingInterruptInference: () => boolean | Promise<boolean>
  dropCommandFinishedStatusIfSameTurn: (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean; subject?: TerminalFactSubject }
  ) => void
}

/** The existing E publishes only into its current resource association. */
export function createTerminalForegroundPublication(services: TerminalForegroundServices) {
  const execution = services.execution ?? services
  const key = () => resolveAgentPaneAuthorityKey(services.paneKey)
  const applicable = () => {
    const state = useAppStore.getState()
    const paneKey = key()
    const pane = parsePaneKey(paneKey)
    const layout = pane ? state.terminalLayoutsByTabId[pane.tabId] : undefined
    const ptyId = pane ? layout?.ptyIdsByLeafId?.[pane.leafId] : undefined
    return (
      (!layout || !pane || collectLeafIds(layout.root).includes(pane.leafId)) &&
      (!ptyId || ptyId === services.getPtyId()) &&
      services.isLive?.() !== false &&
      !state.recentlyRetiredAgentStatusPaneKeys?.[paneKey] &&
      !state.recentlyClosedAgentStatusTabIds?.[paneKey.slice(0, paneKey.lastIndexOf(':'))]
    )
  }
  const current = () => useAppStore.getState().paneForegroundAgentByPaneKey[key()]
  const owns = (entry: PaneForegroundAgentEntry | undefined) =>
    entry?.context?.execution === execution
  const publish = (entry: PaneForegroundAgentEntry) => {
    const ptyId = services.getPtyId()
    if (!ptyId || !applicable()) {
      return
    }
    const prior = current()
    if (prior?.context && !owns(prior)) {
      return
    }
    useAppStore.getState().setPaneForegroundAgent(key(), {
      ...entry,
      context: {
        execution,
        endpoint: services.endpoint,
        executionHost: services.executionHost,
        ptyId,
        incarnationId: services.getExpectedIncarnationId(),
        worktreeId: services.worktreeId,
        environmentId: services.runtimeEnvironmentId ?? null
      }
    })
  }
  return {
    applicable,
    owns,
    current,
    publish,
    captureRead() {
      const paneKey = key()
      const subject = captureTerminalFactSubject(paneKey)
      const pane = parsePaneKey(paneKey)
      const root = pane
        ? useAppStore.getState().terminalLayoutsByTabId[pane.tabId]?.root
        : undefined
      const ptyId = services.getPtyId()
      const incarnation = services.getExpectedIncarnationId()
      const input = services.getInputGeneration?.()
      const prior = current()
      return () =>
        applicable() &&
        key() === paneKey &&
        (!pane || useAppStore.getState().terminalLayoutsByTabId[pane.tabId]?.root === root) &&
        services.getPtyId() === ptyId &&
        services.getExpectedIncarnationId() === incarnation &&
        services.getInputGeneration?.() === input &&
        subject.isCurrent() &&
        (!prior?.context ||
          (current()?.context?.execution === execution &&
            current()?.observationGeneration === prior.observationGeneration &&
            current()?.agentEvidence === prior.agentEvidence &&
            current()?.agent === prior.agent))
    },
    demote() {
      const entry = current()

      if (owns(entry) && entry?.agent && entry.agentEvidence === 'process-read') {
        publish({
          ...entry,
          agentEvidence: 'process-admitted',
          routingTrusted: false,
          routingConfirmationPending: entry.routingConfirmationPending === true
        })
        return true
      }
      return owns(entry) && entry?.agentEvidence === 'process-admitted'
    },
    clear() {
      if (owns(current())) {
        useAppStore.getState().clearPaneForegroundAgent(key())
      }
    }
  }
}

export function requestTerminalForegroundReconfirmation(
  publication: ReturnType<typeof createTerminalForegroundPublication>,
  paneForegroundAgentTracker: PaneForegroundAgentTracker,
  resample: () => void
): void {
  const foreground = publication.current()
  // Why: daemon reattach/launch metadata is display-only until a live
  // provider read confirms it. Submit/interrupt/title-exit evidence must
  // revoke that launch-only hint too, otherwise Shift+Enter can route bytes
  // to an agent that already exited before confirmation ever ran.
  if (
    !foreground?.agent ||
    !isTuiAgent(foreground.agent) ||
    foreground.routingTrusted !== true ||
    TUI_AGENT_CONFIG[foreground.agent].windowsShiftEnterEncoding !== 'csi-u'
  ) {
    return
  }
  // Why: cmd.exe and Git Bash have no OSC command boundaries. Keep the icon
  // as a hint, but revoke bytes until one current provider confirmation lands.
  publication.publish({
    ...foreground,
    routingTrusted: undefined,
    routingConfirmationPending: undefined,
    routingRevoked: true,
    shellForeground: false
  })
  // Why: hook rows can suppress display-only sampling, but cannot restore
  // byte authority after this function explicitly revoked routing trust.
  resample()
  if (paneForegroundAgentTracker.hasReadInFlight()) {
    publication.publish({
      ...publication.current()!,
      routingTrusted: undefined,
      routingRevoked: true,
      shellForeground: false,
      routingConfirmationPending: true
    })
  }
}
