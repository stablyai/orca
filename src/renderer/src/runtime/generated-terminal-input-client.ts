import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  GENERATED_INPUT_RUNTIME_CAPABILITY,
  splitGeneratedInputText,
  type GeneratedInputOutcome,
  type GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'

type SendResult = { delivery?: { outcome: GeneratedInputOutcome }; part?: 'accepted' }

// The host may wait up to the whole budget at a dialog; transport gets room beyond it.
const TRANSPORT_MARGIN_MS = 15_000

/** Hand generated text to the host that owns the PTY, which admits and writes it in one
 *  transaction. Null: that host predates the transaction, so the caller's legacy adapter runs. */
export async function sendGeneratedTerminalInput(
  ptyId: string,
  request: GeneratedInputRequest
): Promise<GeneratedInputOutcome | null> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  const timeoutMs = (request.timeoutMs ?? 0) + TRANSPORT_MARGIN_MS
  try {
    if (!owner) {
      // The local runtime is this renderer's own version; an id it cannot name is left to the adapter.
      const result = await callRuntimeRpc<SendResult>(
        { kind: 'local' },
        'terminal.sendGeneratedInput',
        { ptyId, ...request },
        { timeoutMs }
      )
      const outcome = result.delivery?.outcome ?? 'unconfirmed'
      return outcome === 'target-gone' ? null : outcome
    }
    if (
      !(await runtimeEnvironmentSupportsCapability(
        owner.target.environmentId,
        GENERATED_INPUT_RUNTIME_CAPABILITY
      ))
    ) {
      return null
    }
    const parts = splitGeneratedInputText(request.text)
    const id = createBrowserUuid()
    let result: SendResult = {}
    for (const [index, text] of parts.entries()) {
      result = await callRuntimeRpc<SendResult>(
        owner.target,
        'terminal.sendGeneratedInput',
        {
          ...request,
          terminal: owner.terminal,
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
