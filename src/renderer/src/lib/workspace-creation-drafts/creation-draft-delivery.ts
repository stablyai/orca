import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { refreshLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { iterateAgentDraftPasteContentChunks } from '../agent-draft-paste-content'
import { resolveExplicitWorktreeOperationRouteResult } from '../worktree-operation-route'
import { isWebClientLocation } from '../web-client-location'
import { CLIENT_PLATFORM } from '../new-workspace'
import { getAgentPromptSubmitDelayMs } from '../../../../shared/agent-prompt-injection'
import { TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import { isCreationDraftInputReady } from './creation-draft-readiness'
import { CREATION_DRAFT_TEXT_BYTES } from './creation-draft-record'

export type CreationDraftDeliveryTarget = {
  executionHostId: string
  worktreeId: string
  terminalHandle: string
  incarnationId: string
}

export type CreationDraftDeliveryResult =
  | { status: 'delivered' }
  | {
      status: 'refused'
      reason:
        | 'unsupported-host'
        | 'unsupported-runtime'
        | 'unverified-target'
        | 'invalid-text'
        | 'not-sendable'
        | 'input-not-ready'
    }
  | { status: 'uncertain'; reason: 'transport' | 'partial-delivery' }

type UnverifiedDraftTarget = Omit<CreationDraftDeliveryTarget, 'incarnationId'>

function hasLocalOwner(target: UnverifiedDraftTarget): boolean {
  const resolution = resolveExplicitWorktreeOperationRouteResult(
    useAppStore.getState(),
    target.worktreeId
  )
  return (
    resolution.kind === 'resolved' &&
    resolution.route.executionHostId === 'local' &&
    resolution.route.runtimeEnvironmentId === null
  )
}

async function readNativeTarget(target: UnverifiedDraftTarget) {
  if (
    isWebClientLocation() ||
    target.executionHostId !== 'local' ||
    !target.worktreeId ||
    !target.terminalHandle ||
    !hasLocalOwner(target)
  ) {
    return null
  }
  try {
    const listing = await callRuntimeRpc<RuntimeTerminalListResult>(
      { kind: 'local' },
      'terminal.list',
      {
        handles: [target.terminalHandle],
        includeVisualLayouts: false
      }
    )
    const matches = listing.terminals.filter((entry) => entry.handle === target.terminalHandle)
    const terminal = matches.length === 1 ? matches[0] : undefined
    return terminal?.ptyId &&
      terminal.incarnationId &&
      terminal.worktreeId === target.worktreeId &&
      terminal.executionHostId === 'local' &&
      terminal.connected &&
      terminal.writable &&
      hasLocalOwner(target)
      ? terminal
      : null
  } catch {
    return null
  }
}

export async function captureCreationDraftTarget(args: UnverifiedDraftTarget): Promise<{
  terminalHandle: string
  incarnationId: string
} | null> {
  const target = { ...args }
  if (isWebClientLocation() || target.executionHostId !== 'local' || !hasLocalOwner(target)) {
    return null
  }
  if (
    !(await refreshLocalRuntimeCapabilities()).includes(
      TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY
    )
  ) {
    return null
  }
  const terminal = await readNativeTarget(target)
  return terminal?.incarnationId
    ? {
        terminalHandle: target.terminalHandle,
        incarnationId: terminal.incarnationId
      }
    : null
}

/** The caller must persist its sending attempt first; this operation never retries. */
export async function sendCreationDraft(args: {
  target: CreationDraftDeliveryTarget
  text: string
}): Promise<CreationDraftDeliveryResult> {
  const target = { ...args.target }
  const text = args.text
  if (isWebClientLocation() || target.executionHostId !== 'local') {
    return { status: 'refused', reason: 'unsupported-host' }
  }
  if (
    !target.worktreeId ||
    !target.terminalHandle ||
    !target.incarnationId ||
    !hasLocalOwner(target)
  ) {
    return { status: 'refused', reason: 'unverified-target' }
  }
  const byteLength = new TextEncoder().encode(text).byteLength
  if (!text.trim() || byteLength > CREATION_DRAFT_TEXT_BYTES) {
    return { status: 'refused', reason: 'invalid-text' }
  }
  if (
    !(await refreshLocalRuntimeCapabilities()).includes(
      TERMINAL_SEND_INCARNATION_RUNTIME_CAPABILITY
    )
  ) {
    return { status: 'refused', reason: 'unsupported-runtime' }
  }
  const terminal = await readNativeTarget(target)
  if (!terminal?.ptyId || terminal.incarnationId !== target.incarnationId) {
    return { status: 'refused', reason: 'unverified-target' }
  }
  return runTerminalPtyInputTransaction(terminal.ptyId, async () => {
    let acceptedBytes = false
    if (!(await isCreationDraftInputReady(target.terminalHandle))) {
      return { status: 'refused', reason: 'input-not-ready' }
    }
    const send = async (
      payload: { text: string } | { enter: true }
    ): Promise<CreationDraftDeliveryResult | null> => {
      if (!hasLocalOwner(target)) {
        return acceptedBytes
          ? { status: 'uncertain', reason: 'partial-delivery' }
          : { status: 'refused', reason: 'unverified-target' }
      }
      try {
        const { send: result } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
          { kind: 'local' },
          'terminal.send',
          {
            terminal: target.terminalHandle,
            expectedIncarnationId: target.incarnationId,
            requireAgentStatus: 'sendable',
            client: { id: 'orca-desktop', type: 'desktop' },
            ...payload
          }
        )
        if (result.accepted !== true) {
          return acceptedBytes || result.bytesWritten !== 0
            ? { status: 'uncertain', reason: 'partial-delivery' }
            : { status: 'refused', reason: 'not-sendable' }
        }
        const expectedBytes =
          'text' in payload ? new TextEncoder().encode(payload.text).byteLength : 1
        if (result.handle !== target.terminalHandle || result.bytesWritten !== expectedBytes) {
          return { status: 'uncertain', reason: 'partial-delivery' }
        }
        acceptedBytes = true
        return null
      } catch {
        return { status: 'uncertain', reason: 'transport' }
      }
    }
    // Each bounded frame uses one guarded RPC; a later refusal never replays earlier frames.
    for (const chunk of iterateAgentDraftPasteContentChunks(text)) {
      const failure = await send({ text: chunk })
      if (failure) {
        return failure
      }
    }
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, getAgentPromptSubmitDelayMs(CLIENT_PLATFORM, byteLength))
    )
    if (!(await isCreationDraftInputReady(target.terminalHandle))) {
      return { status: 'uncertain', reason: 'partial-delivery' }
    }
    return (await send({ enter: true })) ?? { status: 'delivered' }
  })
}
