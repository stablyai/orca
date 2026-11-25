import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  runCodeBlockScript,
  type CodeBlockScriptRunner
} from '../../../../../shared/code-block-terminal-run'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Code blocks run in the chat's workspace on the chat's own host. */
export function nativeChatCodeBlockRunner(
  target: RuntimeClientTarget,
  worktreeId: string
): CodeBlockScriptRunner {
  return (script, onUpdate) =>
    runCodeBlockScript({
      worktreeId,
      script,
      onUpdate,
      call: (method, params) => callRuntimeRpc(target, method, params)
    })
}
