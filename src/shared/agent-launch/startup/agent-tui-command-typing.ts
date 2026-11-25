import { AGENT_TUI_CLEAR_INPUT_LINE } from './agent-tui-input-clear'

export type AgentTuiCommandWriteOutcome = 'accepted' | 'rejected' | 'unknown'

export const AGENT_TUI_COMMAND_KEY_INTERVAL_MS = 16

function waitForNextKey(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), AGENT_TUI_COMMAND_KEY_INTERVAL_MS)
    const finish = (completed: boolean): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Sends one PTY write per key so slash-command TUIs do not classify it as pasted prose. */
export async function typeAgentTuiCommand(args: {
  command: string
  write: (key: string) => Promise<AgentTuiCommandWriteOutcome>
  signal?: AbortSignal
}): Promise<AgentTuiCommandWriteOutcome> {
  const keys = [AGENT_TUI_CLEAR_INPUT_LINE, ...args.command, '\r']
  for (let index = 0; index < keys.length; index += 1) {
    if (args.signal?.aborted) {
      return 'rejected'
    }
    const outcome = await args.write(keys[index]!)
    if (outcome !== 'accepted') {
      return outcome
    }
    if (index < keys.length - 1 && !(await waitForNextKey(args.signal))) {
      return 'rejected'
    }
  }
  return 'accepted'
}
