// Main writes/starts splits under the window pane ID; frame reconciliation draws and attaches its terminal.
import type { TerminalPaneSplitSource } from '../../../../../../shared/feature-education-telemetry'
import { mintStablePaneId } from '@/lib/pane-manager/pane-layout/mint-stable-pane-id'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute
} from '@/lib/workspace/ownership/worktree-operation-route'
import { resolveTerminalPaneOwnerContext } from '../../host-state/terminal-pane-owner-context'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../../../shared/ephemeral-setup-terminal-worktree-id'
import {
  captureTerminalCreationNavigation,
  focusAcceptedTerminalPane
} from '@/store/terminals/terminal-creation-navigation'
import {
  runtimeEnvironmentCapabilityProof,
  type RuntimeCapabilityProof
} from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../../shared/session-tabs-runtime-capabilities'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { toWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import type { RuntimeTerminalSplit } from '../../../../../../shared/runtime-terminal-contracts'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { captureWebSessionIntentOwner } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import type { WebSessionIntentOwner } from '@/runtime/web-session-tabs-sync/identity/web-session-intent-owner'
import { qualifyRetainedWebRuntimeStart } from '@/runtime/hosted-terminals/creation/web-runtime-retained-terminal-create'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { serverLayoutApplyRoute } from '@/runtime/workspace-layout/server/server-layout-apply-routes'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { expectPaneToMountUnfocused } from '@/runtime/workspace-layout/intents/layout-owner-pane-intents'
import { useAppStore } from '@/store/index'
import {
  projectRetainedTerminalStart,
  retainedStartFromRpcError
} from '@/store/terminals/retained-terminal-start'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

export type SplitInMainRequest = {
  worktreeId: string
  tabId: string
  sourceLeafId: string
  direction: 'vertical' | 'horizontal'
  cwd?: string | Promise<string>
  initialSize?: { cols: number; rows: number }
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  /** The user's split; startup splits record no interaction. */
  telemetry?: { source: TerminalPaneSplitSource }
  /** Focus stays on the source pane when the new pane mounts, as a startup split's does. */
  keepSourceFocused?: true
}

/** Only the qualified local provider takes this route; direct SSH keeps its IPC provider. */
export function splitPaneInMain(request: SplitInMainRequest, _asToday: () => void): boolean {
  if (isEphemeralSetupTerminalWorktreeId(request.worktreeId)) {
    return false
  }
  const state = useAppStore.getState()
  const owner = resolveSplitPaneOwner(state, request)
  if (!owner.tab || owner.unresolved) {
    toast.error(
      translate(
        'auto.store.slices.editor.gitOperationTarget.unresolvedHost',
        'The workspace host is unresolved. Refresh the workspace and retry.'
      )
    )
    return true
  }
  if (owner.runtimeEnvironmentId) {
    return false
  }
  if (owner.connectionId) {
    return false
  }
  sendPaneSplit({ kind: 'local' }, request, request.tabId)
  return true
}

/** Choose legacy or expanded pane semantics before dispatch, pinned to the serving host. */
export function splitServerPane(request: SplitInMainRequest, asToday?: () => void): boolean {
  if (isEphemeralSetupTerminalWorktreeId(request.worktreeId)) {
    return false
  }
  const state = useAppStore.getState()
  const owner = resolveSplitPaneOwner(state, request)
  const environmentId = owner.runtimeEnvironmentId
  if (!owner.tab || owner.unresolved || !environmentId) {
    return false
  }
  const route = serverLayoutApplyRoute(environmentId, request.worktreeId)
  const serverTabId =
    route?.serverTabId(request.tabId) ??
    resolveHostSessionTabIdForWebSessionTab(state, {
      environmentId,
      worktreeId: request.worktreeId,
      tabId: request.tabId
    })
  if (!serverTabId) {
    return false
  }
  const navigation = captureTerminalCreationNavigation()
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  void runtimeEnvironmentCapabilityProof(
    environmentId,
    TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY
  ).then(
    (proof) => {
      if (
        getRuntimeEnvironmentRevision(environmentId) !== intentOwner.pairingRevision ||
        proof.pairingRevision !== intentOwner.pairingRevision
      ) {
        navigation.dispose()
        toast.error(
          translate(
            'auto.lib.dropFailureReason.hostUnreachable',
            'The connection to the host changed or dropped. Try again.'
          )
        )
        return
      }
      if (!proof.supported && (!ORCA_LAYOUT_OWNER_IS_MAIN || !route)) {
        navigation.dispose()
        asToday?.()
        return
      }
      sendPaneSplit(
        { kind: 'environment', environmentId },
        request,
        serverTabId,
        proof,
        navigation,
        intentOwner
      )
    },
    (error: unknown) => {
      navigation.dispose()
      toast.error(error instanceof Error ? error.message : String(error))
    }
  )
  return true
}

function resolveSplitPaneOwner(
  state: ReturnType<typeof useAppStore.getState>,
  request: SplitInMainRequest
) {
  return resolveTerminalPaneOwnerContext(
    state,
    request.worktreeId,
    request.tabId,
    getFloatingWorkspaceOperationRoute(request.worktreeId) ??
      resolveWorktreeOperationRoute(state, request.worktreeId),
    state.terminalLayoutsByTabId[request.tabId]?.ptyIdsByLeafId?.[request.sourceLeafId]
  )
}

function sendPaneSplit(
  target: RuntimeClientTarget,
  request: SplitInMainRequest,
  hostTabId: string,
  proof?: RuntimeCapabilityProof,
  navigation = captureTerminalCreationNavigation(),
  intentOwner?: WebSessionIntentOwner
): void {
  const { worktreeId, tabId, sourceLeafId, direction, telemetry } = request
  const newLeafId = mintStablePaneId()
  // Publication can beat the reply; only this caller may focus its accepted split.
  const forgetFocus = expectPaneToMountUnfocused(tabId, newLeafId)
  void (async () => {
    const cwd = await request.cwd
    const result = await callRuntimeRpc<{ split: RuntimeTerminalSplit }>(
      target,
      'terminal.split',
      {
        pane: { worktreeId, tabId: hostTabId, leafId: sourceLeafId },
        newLeafId,
        direction,
        activate: false,
        ...(cwd ? { cwd } : {}),
        ...(request.initialSize ? { initialSize: request.initialSize } : {}),
        ...(request.command !== undefined ? { command: request.command } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.envToDelete ? { envToDelete: request.envToDelete } : {})
      },
      proof
        ? {
            expectedEnvironmentPairingRevision: proof.pairingRevision,
            expectedEnvironmentRuntimeId: proof.runtimeId
          }
        : {}
    )
    if (target.kind === 'environment') {
      await refreshWebRuntimeSessionTabsSnapshot(target.environmentId, worktreeId, {
        expectedEnvironmentPairingRevision: proof?.pairingRevision,
        acceptCurrentSnapshot: true
      })
    }
    if (!request.keepSourceFocused && navigation.current() && result.split.leafId === newLeafId) {
      navigation.dispose()
      focusAcceptedTerminalPane(
        target.kind === 'local' ? tabId : toWebTerminalSurfaceTabId(hostTabId),
        newLeafId
      )
    }
    if (telemetry) {
      recordCreatedTerminalPaneSplit(true, { source: telemetry.source, direction })
    }
  })()
    .catch((error: unknown) => {
      forgetFocus()
      const retained = retainedStartFromRpcError(error)
      const paired =
        target.kind === 'environment' && intentOwner
          ? qualifyRetainedWebRuntimeStart(retained, {
              worktreeId,
              environmentId: target.environmentId,
              intentOwner,
              proof
            })
          : null
      if (
        (target.kind === 'local' || paired) &&
        retained?.worktreeId === worktreeId &&
        retained.tabId === hostTabId &&
        retained.leafId === newLeafId &&
        projectRetainedTerminalStart(retained, {
          worktreeId,
          tabId,
          ...(paired ? { paired } : {}),
          splitFromLeafId: sourceLeafId,
          splitDirection: direction
        })
      ) {
        if (!request.keepSourceFocused && navigation.current()) {
          focusAcceptedTerminalPane(tabId, newLeafId)
        }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
      console.warn('[terminal] split could not be confirmed:', message)
    })
    .finally(() => navigation.dispose())
}

/** A first size for the new pane: its share of the source pane's grid, until it is laid out. */
export function splitPaneFirstSize(
  source: { cols: number; rows: number },
  direction: 'vertical' | 'horizontal'
): { cols: number; rows: number } {
  return direction === 'vertical'
    ? { cols: Math.max(1, Math.floor(source.cols / 2)), rows: source.rows }
    : { cols: source.cols, rows: Math.max(1, Math.floor(source.rows / 2)) }
}
