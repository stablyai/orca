import { createBrowserUuid } from '@/lib/browser-uuid'
import { splitGeneratedInputText } from '../../../shared/generated-terminal-input'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY } from '../../../shared/terminal-runtime-capabilities'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

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

/** Where a request's failure notice is kept: this window's runtime, or a host that keeps notices
 *  by operation id itself. An older host is never asked to keep a second one. */
export async function generatedInputNoticeOwner(
  remote: RuntimeClientTarget | null
): Promise<{ target: RuntimeClientTarget; hostKeeps: boolean }> {
  if (!remote || remote.kind === 'local') {
    return { target: LOCAL, hostKeeps: true }
  }
  const hostKeeps = await runtimeEnvironmentSupportsCapability(
    remote.environmentId,
    GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY
  ).catch(() => false)
  return { target: remote, hostKeeps }
}

export { LOCAL as LOCAL_NOTICE_RUNTIME }
