import { toast } from 'sonner'
import { captureTerminalCreationNavigation } from '@/store/terminals/terminal-creation-navigation'
import { runtimeEnvironmentCapabilityProof } from '../../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/session-tabs-runtime-capabilities'
import type { TerminalPaneSplitSource } from '../../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../../shared/runtime-terminal-contracts'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive,
  matchesWebSessionIntentOwner
} from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import {
  beginWebRuntimeSplitFocusRequest,
  captureWebRuntimeSplitFocusTarget,
  finishWebRuntimeSplitFocusRequest,
  focusSplitWebRuntimeTerminalPane,
  type WebRuntimeSplitSource
} from './web-runtime-split-focus'

const pendingWebRuntimeSplitMirrorTelemetry = new Map<string, Set<string>>()

const WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS = 30_000

let pendingWebRuntimeSplitMirrorTelemetryId = 0

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical',
  telemetrySource: TerminalPaneSplitSource,
  source?: WebRuntimeSplitSource,
  launch?: { cwd?: string | Promise<string>; initialSize?: { cols: number; rows: number } }
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Split on the host pane; local splits mint web-only panes the host mirrors as separate tabs.
  const pendingMirrorSuppressionId = reservePendingWebRuntimeSplitMirrorTelemetry(ptyId, direction)
  const releasePendingMirrorSuppression = schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
    ptyId,
    direction,
    pendingMirrorSuppressionId
  )
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const focusTarget = source ? captureWebRuntimeSplitFocusTarget(ptyId, source) : null
  // Advance the fence for every source-bearing gesture, even when its pane metadata is stale.
  const focusRequest = source
    ? beginWebRuntimeSplitFocusRequest(intentOwner, source.worktreeId)
    : null
  const navigation = captureTerminalCreationNavigation()
  void (async () => {
    if (!launch) {
      return await callRuntimeRpc<{ split: RuntimeTerminalSplit }>(
        { kind: 'environment', environmentId },
        'terminal.split',
        { terminal: remote.handle, direction, telemetrySource },
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
          skipCompatibilityCheck: true
        }
      )
    }
    const proof = await runtimeEnvironmentCapabilityProof(
      environmentId,
      TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY
    )
    if (!matchesWebSessionIntentOwner(intentOwner)) {
      throw new Error('The workspace host changed before the split request.')
    }
    const cwd = proof.supported ? await launch.cwd : undefined
    return await callRuntimeRpc<{ split: RuntimeTerminalSplit }>(
      { kind: 'environment', environmentId },
      'terminal.split',
      {
        terminal: remote.handle,
        direction,
        telemetrySource,
        ...(proof.supported ? { activate: false, cwd, initialSize: launch.initialSize } : {})
      },
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: proof.pairingRevision,
        expectedEnvironmentRuntimeId: proof.runtimeId
      }
    )
  })()
    .then(async (result) => {
      if (navigation.current()) {
        await focusSplitWebRuntimeTerminalPane(
          intentOwner,
          focusTarget,
          focusRequest,
          result?.split,
          navigation.current
        )
      }
    })
    .catch((error) => {
      releasePendingMirrorSuppression()
      const message = error instanceof Error ? error.message : String(error)
      // Report failed splits visibly or the requested pane silently never appears.
      toast.error(message)
      console.warn('[web-runtime-session] failed to split terminal:', message)
    })
    .finally(() => {
      navigation.dispose()
      finishWebRuntimeSplitFocusRequest(focusRequest)
    })
  return true
}

export function consumePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string | null | undefined,
  direction: 'horizontal' | 'vertical'
): boolean {
  if (!sourcePtyId) {
    return false
  }
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  const id = ids?.values().next().value
  if (!ids || !id) {
    return false
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
  return true
}

function reservePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  const id = String(++pendingWebRuntimeSplitMirrorTelemetryId)
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key) ?? new Set<string>()
  ids.add(id)
  pendingWebRuntimeSplitMirrorTelemetry.set(key, ids)
  return id
}

function schedulePendingWebRuntimeSplitMirrorTelemetryRelease(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): () => void {
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    releasePendingWebRuntimeSplitMirrorTelemetry(sourcePtyId, direction, id)
  }
  const timeout = globalThis.setTimeout(release, WEB_RUNTIME_SPLIT_MIRROR_SUPPRESSION_TTL_MS)
  return () => {
    globalThis.clearTimeout(timeout)
    release()
  }
}

function releasePendingWebRuntimeSplitMirrorTelemetry(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical',
  id: string
): void {
  const key = getPendingWebRuntimeSplitMirrorTelemetryKey(sourcePtyId, direction)
  const ids = pendingWebRuntimeSplitMirrorTelemetry.get(key)
  if (!ids) {
    return
  }
  ids.delete(id)
  if (ids.size === 0) {
    pendingWebRuntimeSplitMirrorTelemetry.delete(key)
  }
}

function getPendingWebRuntimeSplitMirrorTelemetryKey(
  sourcePtyId: string,
  direction: 'horizontal' | 'vertical'
): string {
  return `${direction}:${sourcePtyId}`
}
