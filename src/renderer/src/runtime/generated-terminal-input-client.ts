import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  GENERATED_INPUT_RUNTIME_CAPABILITY,
  splitGeneratedInputText,
  type GeneratedInputOutcome,
  type GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

type SendResult = { delivery?: { outcome: GeneratedInputOutcome }; part?: 'accepted' }

// The host may wait up to the whole budget at a dialog; transport gets room beyond it.
const TRANSPORT_MARGIN_MS = 15_000

/** Hand generated text to the host that owns the PTY, which admits and writes it in one
 *  transaction. Null only when that host predates the transaction, so the caller's legacy adapter
 *  runs; every other answer, target-gone included, is the host's own outcome. */
export async function sendGeneratedTerminalInput(
  ptyId: string,
  request: GeneratedInputRequest
): Promise<GeneratedInputOutcome | null> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  return owner
    ? sendGeneratedTerminalInputToHandle(owner.target, owner.terminal, request)
    : sendToHost({ kind: 'local' }, { ptyId }, request)
}

/** The same operation for a caller that names a runtime terminal handle (notes). */
export async function sendGeneratedTerminalInputToHandle(
  target: RuntimeClientTarget,
  terminal: string,
  request: GeneratedInputRequest
): Promise<GeneratedInputOutcome | null> {
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GENERATED_INPUT_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return sendToHost(target, { terminal }, request)
}

async function sendToHost(
  target: RuntimeClientTarget,
  address: { ptyId: string } | { terminal: string },
  request: GeneratedInputRequest
): Promise<GeneratedInputOutcome> {
  const timeoutMs = (request.timeoutMs ?? 0) + TRANSPORT_MARGIN_MS
  // The local runtime is this renderer's own version and takes the text in one request.
  const parts = target.kind === 'local' ? [request.text] : splitGeneratedInputText(request.text)
  const id = createBrowserUuid()
  try {
    let result: SendResult = {}
    for (const [index, text] of parts.entries()) {
      result = await callRuntimeRpc<SendResult>(
        target,
        'terminal.sendGeneratedInput',
        {
          ...request,
          ...address,
          text,
          ...(parts.length > 1 ? { part: { id, index, final: index === parts.length - 1 } } : {})
        },
        { timeoutMs }
      )
    }
    return result.delivery?.outcome ?? 'unconfirmed'
  } catch {
    // A lost answer cannot prove nothing was written, so the text is never sent again here.
    return 'unconfirmed'
  }
}
