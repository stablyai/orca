import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import {
  readTerminalModelControlResult,
  type TerminalModelControl
} from '../../../../../../../shared/native-chat/input/native-chat-terminal-model-control'
import type { RuntimeTerminalResolvePane } from '../../../../../../../shared/runtime-terminal-contracts'
import { TERMINAL_MODEL_CONTROL_RUNTIME_CAPABILITY } from '../../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  cancelNativeChatPtySends,
  waitForNativeChatPtyIdle
} from '../../terminal/send/native-chat-pty-send-queue'

/** Null is a proven no-effect handoff to the captured legacy dispatcher. */
export async function sendNativeChatHostModelControl(args: {
  ptyId: string
  paneKey?: string
  control: TerminalModelControl
  isCurrent: () => boolean
}) {
  const owner = getRemoteRuntimePtyOwner(args.ptyId)
  if (!owner && !args.paneKey) {
    return null
  }
  const target = owner?.target ?? { kind: 'local' as const }
  const proof = owner
    ? await runtimeEnvironmentCapabilityProof(
        owner.target.environmentId,
        TERMINAL_MODEL_CONTROL_RUNTIME_CAPABILITY,
        15_000
      ).catch(() => null)
    : null
  const supported = owner
    ? proof?.supported
    : (await ensureLocalRuntimeCapabilities().catch(() => null))?.includes(
        TERMINAL_MODEL_CONTROL_RUNTIME_CAPABILITY
      )
  if (supported !== true) {
    return null
  }
  if (!args.isCurrent()) {
    return {
      outcome: 'blocked' as const,
      agent: args.control.agent,
      reason: 'target-unavailable' as const
    }
  }
  cancelNativeChatPtySends(args.ptyId, true)
  await waitForNativeChatPtyIdle(args.ptyId)
  const resolved = owner
    ? null
    : await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
        target,
        'terminal.resolvePane',
        { paneKey: args.paneKey }
      )
  if (!args.isCurrent() || (resolved && resolved.terminal.ptyId !== args.ptyId)) {
    return {
      outcome: 'blocked' as const,
      agent: args.control.agent,
      reason: 'target-unavailable' as const
    }
  }
  try {
    const response = await callRuntimeRpc<{ control: unknown }>(
      target,
      'terminal.model-control',
      {
        ...args.control,
        terminal: owner?.terminal ?? resolved!.terminal.handle,
        ...(resolved?.terminal.incarnationId
          ? { expectedIncarnationId: resolved.terminal.incarnationId }
          : {}),
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      {
        timeoutMs: 65_000,
        skipCompatibilityCheck: true,
        expectedEnvironmentPairingRevision: proof?.pairingRevision,
        expectedEnvironmentRuntimeId: proof?.runtimeId
      }
    )
    const result = readTerminalModelControlResult(response.control)
    return result.outcome === 'legacy' ? null : result
  } catch (error) {
    return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
      ? null
      : { outcome: 'unknown' as const }
  }
}
