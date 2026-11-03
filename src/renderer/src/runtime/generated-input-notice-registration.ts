import { createBrowserUuid } from '@/lib/browser-uuid'
import { splitGeneratedInputText } from '../../../shared/generated-terminal-input'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

const REGISTER = 'terminal.generatedInputNotices.register'
const LOCAL: RuntimeClientTarget = { kind: 'local' }

export type GeneratedInputNoticeFields = Omit<GeneratedAgentInputNotice, 'handle' | 'worktreeId'> &
  Partial<Pick<GeneratedAgentInputNotice, 'handle' | 'worktreeId'>>

/** Registers one operation's notice with `target`'s runtime session, in bounded parts when
 *  remote. Never writes to a terminal; registering the same id again lands on the same record.
 *  False when that runtime could not keep it (the caller then shows its own notice). */
export async function registerGeneratedInputNotice(
  target: RuntimeClientTarget,
  notice: GeneratedInputNoticeFields,
  extra: { pending?: boolean; owner?: string } = {}
): Promise<boolean> {
  try {
    // The local runtime is this renderer's own version and takes the text in one request.
    const parts = target.kind === 'local' ? [notice.text] : splitGeneratedInputText(notice.text)
    const partId = createBrowserUuid()
    let result: { retained?: boolean } = {}
    for (const [index, text] of parts.entries()) {
      result = await callRuntimeRpc<{ retained?: boolean }>(
        target,
        REGISTER,
        {
          ...notice,
          text,
          ...(extra.pending ? { pending: true } : {}),
          ...(extra.owner ? { owner: extra.owner } : {}),
          ...(parts.length > 1
            ? { part: { id: partId, index, final: index === parts.length - 1 } }
            : {})
        },
        { timeoutMs: 15_000 }
      )
    }
    return result.retained === true
  } catch {
    return false
  }
}

/** This window's pending record for `id` is no longer needed: delivered, or its owner kept it. */
export function settleGeneratedInputNotice(id: string): void {
  void callRuntimeRpc(LOCAL, REGISTER, {
    id,
    settle: true,
    text: '',
    agent: null,
    certainty: 'not-sent'
  }).catch(() => {})
}

export { LOCAL as LOCAL_NOTICE_RUNTIME }
