import { useAppStore } from '@/store'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { captureWorkspaceSelection, restoreWorkspaceSelection } from '@/lib/active-workspace-host'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { captureSourceTerminal } from '../tab-bar/cli-chat-resume-terminal-capture'
import { requestActiveTerminalPaneClose } from '../terminal-pane/request-active-terminal-pane-close'
import { subscribeToPtyExit } from '../terminal-pane/pty-dispatcher'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import type { RuntimeTerminalClose } from '../../../../shared/runtime-types'
import type { HeldTerminalTarget } from './native-chat-held-terminal'

export const HOLDING_TERMINAL_EXIT_TIMEOUT_MS = 10_000

export async function captureHeldTerminal(target: HeldTerminalTarget) {
  const host = parseExecutionHostId(target.executionHostId)
  const owner = host?.kind === 'runtime' ? captureWebSessionIntentOwner(host.environmentId) : null
  const captured = await captureSourceTerminal({
    tabId: target.tabId,
    workspaceId: target.worktreeId,
    paneKey: target.paneKey,
    executionHostId: target.executionHostId,
    ptyId: target.ptyId ?? undefined
  })
  return captured?.incarnationId === target.incarnationId &&
    (!owner || matchesWebSessionIntentOwner(owner))
    ? captured
    : null
}

/** Consent authorizes only this captured execution; stopping it never submits another action. */
export async function closeHoldingTerminal(target: HeldTerminalTarget): Promise<boolean> {
  const initial = useAppStore.getState()
  const origin = captureWorkspaceSelection(initial)
  const originTab = initial.activeWorktreeId
    ? resolveWebSessionVisibleTabId(initial, initial.activeWorktreeId)
    : null
  const host = parseExecutionHostId(target.executionHostId)
  const owner = host?.kind === 'runtime' ? captureWebSessionIntentOwner(host.environmentId) : null
  const hostCurrent = () => !owner || matchesWebSessionIntentOwner(owner)
  const call = owner
    ? captureRuntimeEnvironmentCall(owner.environmentId, owner.pairingRevision)
    : null
  const sameNavigation = (state: typeof initial, before: typeof initial) =>
    state.activeWorktreeId === before.activeWorktreeId &&
    state.activeWorkspaceExecutionHostId === before.activeWorkspaceExecutionHostId &&
    state.activeView === before.activeView &&
    state.worktreeNavHistory === before.worktreeNavHistory &&
    state.worktreeNavHistoryIndex === before.worktreeNavHistoryIndex &&
    (!before.activeWorktreeId ||
      resolveWebSessionVisibleTabId(state, before.activeWorktreeId) ===
        resolveWebSessionVisibleTabId(before, before.activeWorktreeId))
  const surface = captureTerminalSurfaceIdentity(
    initial,
    target.worktreeId,
    target.tabId,
    target.leafId
  )
  const surfaceCurrent = () => {
    const current = captureTerminalSurfaceIdentity(
      useAppStore.getState(),
      target.worktreeId,
      target.tabId,
      target.leafId
    )
    return !!surface && !!current?.hasLeaf && isRetainedTerminalSurfaceIdentity(surface, current)
  }
  const captured = await captureHeldTerminal(target)
  // A later deliberate navigation relinquishes even the temporary reveal.
  if (
    !captured?.presentation ||
    !captured.supportsPinCloseConsent ||
    !hostCurrent() ||
    !sameNavigation(useAppStore.getState(), initial) ||
    !surfaceCurrent()
  ) {
    return false
  }
  useAppStore.setState({ isNavigatingHistory: true })
  try {
    if (!revealTerminalPane(target)) {
      return false
    }
  } finally {
    useAppStore.setState({ isNavigatingHistory: initial.isNavigatingHistory })
  }
  const revealed = useAppStore.getState()
  const ownsReveal = () => sameNavigation(useAppStore.getState(), revealed)
  let navigated = false
  let cancelPending = () => {}
  const stopNavigation = useAppStore.subscribe(() => {
    if (!surfaceCurrent()) {
      cancelPending()
      return
    }
    if (!ownsReveal()) {
      navigated = true
      cancelPending()
    }
  })
  const restore = () => {
    if (navigated || !ownsReveal()) {
      return
    }
    restoreWorkspaceSelection(useAppStore.getState(), origin)
    if (originTab && origin.worktreeId) {
      useAppStore
        .getState()
        .activateTab(originTab, { worktreeId: origin.worktreeId, recordFocus: false })
    }
    useAppStore.getState().setActiveView(initial.activeView)
  }
  return new Promise<boolean>((resolve) => {
    const abort = new AbortController()
    let settled = false,
      confirmed = false
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopExit = () => {}
    let stopLifetime = () => {}
    let stopRevision = () => {}
    let stopRetirement = () => {}
    const finish = (closed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      clearTimeout(timer)
      stopExit()
      stopLifetime()
      stopRevision()
      stopRetirement()
      stopNavigation()
      restore()
      abort.abort()
      resolve(closed && hostCurrent())
    }
    cancelPending = () => {
      if (!confirmed) {
        finish(false)
      }
    }
    const hostChanged = () => {
      if (!hostCurrent()) {
        finish(false)
      }
    }
    stopRevision = onRuntimeEnvironmentRevisionsChanged(hostChanged)
    stopRetirement = onRuntimeEnvironmentsRetired((ids) => {
      if (owner && ids.includes(owner.environmentId)) {
        finish(false)
      }
    })
    stopLifetime = owner
      ? subscribeAcceptedWebSessionTerminalHandle(
          {
            environmentId: owner.environmentId,
            worktreeId: target.worktreeId,
            hostTabId: toHostSessionTabId(target.tabId),
            leafId: target.leafId
          },
          (update) => {
            if (
              !confirmed &&
              (!update.surfacePresent || update.incarnationId !== captured.incarnationId)
            ) {
              finish(false)
            }
          }
        )
      : window.api.pty.onSpawned((event) => {
          if (
            !confirmed &&
            event.id === target.ptyId &&
            event.incarnationId !== captured.incarnationId
          ) {
            finish(false)
          }
        })
    // Host capture supplies the incarnation even when the renderer's optional map is absent.
    if (!owner && target.ptyId) {
      const watch: Parameters<typeof subscribeToPtyExit>[1] = (code, context) => {
        if (settled) {
          return
        }
        if (context.incarnationId !== captured.incarnationId) {
          stopExit = subscribeToPtyExit(target.ptyId ?? '', watch)
          return
        }
        finish(confirmed && isProvenProcessExit(code))
      }
      stopExit = subscribeToPtyExit(target.ptyId, watch)
    }
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!hostCurrent() || navigated) {
        finish(false)
        return
      }
      const accepted = requestActiveTerminalPaneClose(target.tabId, {
        leafId: target.leafId,
        signal: abort.signal,
        isCurrent: () => hostCurrent() && !settled && surfaceCurrent(),
        onCancel: () => finish(false),
        onConfirm: (force) => {
          if (confirmed || settled) {
            return
          }
          if (!hostCurrent() || !surfaceCurrent()) {
            finish(false)
            return
          }
          confirmed = true
          timer = setTimeout(() => finish(false), HOLDING_TERMINAL_EXIT_TIMEOUT_MS)
          const params = {
            terminal: captured.handle,
            expectedIncarnationId: captured.incarnationId,
            originalPresentation: captured.presentation,
            ...(force === true ? { force } : {})
          }
          const closing = call
            ? call({ method: 'terminal.close', params }).then((response) =>
                unwrapRuntimeRpcResult<{ close: RuntimeTerminalClose }>(response)
              )
            : callRuntimeRpc<{ close: RuntimeTerminalClose }>(
                captured.target,
                'terminal.close',
                params
              )
          stopNavigation()
          restore()
          void closing.then(
            (result) =>
              finish(result.close?.ptyKilled === true && result.close.ptyStopVerdict === undefined),
            () => finish(false)
          )
        }
      })
      if (!accepted) {
        finish(false)
      }
    })
  })
}
