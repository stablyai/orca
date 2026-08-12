import { copyTerminalHandleForPaneKey } from '@/components/terminal-pane/terminal-handle-copy'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

type CallRuntime = (request: {
  method: 'terminal.resolvePane'
  params: { paneKey: string }
}) => Promise<RuntimeRpcResponse<unknown>>

// Why: sidebar rows need the same runtime handle orchestration CLI flags use
// (`--to`, `--from`, `--terminal`) without opening the terminal pane first.
export async function resolveTerminalHandleForPaneKey(args: {
  paneKey: string
  callRuntime: CallRuntime
}): Promise<string> {
  // Reuse the terminal-pane resolver; discard the clipboard write path by
  // capturing the returned handle from a no-op writer when callers only need
  // the id for templating other orchestration commands.
  return copyTerminalHandleForPaneKey({
    paneKey: args.paneKey,
    callRuntime: args.callRuntime,
    writeClipboardText: async () => undefined
  })
}

// Why: ready-to-paste coordinator commands for the skill's send/ask flows so
// users can route agent-to-agent messages without retyping the handle.
export function buildOrchestrationSendCommand(handle: string): string {
  return `orca orchestration send --to ${handle} --subject "" --json`
}

export function buildOrchestrationAskCommand(handle: string): string {
  // Why: orchestration.ask no longer takes --to; coordinator→worker questions
  // are send --type question.
  return `orca orchestration send --to ${handle} --type question --subject "" --json`
}

// Why: group fan-out address from the orchestration skill (`@worktree:<id>`).
export function buildWorktreeGroupAddress(worktreeId: string): string {
  return `@worktree:${worktreeId}`
}
