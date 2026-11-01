import type { DraftPasteReadySignal } from '../../../shared/tui-agent-config'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import { waitForGeneratedAgentInput } from '../../../shared/generated-agent-input-readiness'
import { findAgentInputDialogIndex } from '../../../shared/agent-input-dialog'
import { readScreenInputVeto } from '../../../shared/screen-input-veto'
import {
  isExpectedAgentProcess,
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { readPtyInputScreen } from '@/components/terminal-pane/pty-buffer-serializer'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData } from '@/components/terminal-pane/pty-pre-handler-buffer'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'

export async function agentInputScreenIsClear(ptyId: string, agent?: TuiAgent): Promise<boolean> {
  const screen = await readPtyInputScreen(ptyId)
  return (
    screen !== null &&
    readScreenInputVeto(agent, () => screen) !== true &&
    findAgentInputDialogIndex(screen.lines.join('\n')) === null
  )
}

export async function agentInputIsAdmitted(
  ptyId: string,
  agent?: TuiAgent,
  quiet = false
): Promise<boolean> {
  if (!(await agentInputScreenIsClear(ptyId, agent))) {
    return false
  }
  const process = await inspectRuntimeTerminalProcess(ptyId)
  const foreground = process.foregroundProcess ?? ''
  if (foreground && isShellProcess(foreground)) {
    return false
  }
  const expected = agent ? TUI_AGENT_CONFIG[agent].expectedProcess : null
  const expectedInFront = expected
    ? isExpectedAgentProcess(foreground, expected)
    : recognizeAgentProcess(foreground) !== null
  if (quiet && !expectedInFront) {
    if (!(isAgentForegroundWrapperProcess(foreground) && process.hasChildProcesses)) {
      return false
    }
  }
  if (
    foreground &&
    expected &&
    !isExpectedAgentProcess(foreground, expected) &&
    !(isAgentForegroundWrapperProcess(foreground) && process.hasChildProcesses)
  ) {
    return false
  }
  return agentInputScreenIsClear(ptyId, agent)
}

export function waitForAgentDraftInputReady(
  ptyId: string,
  timeoutMs: number,
  readySignal: DraftPasteReadySignal,
  agent?: TuiAgent,
  signal?: AbortSignal,
  initialData = ''
): Promise<boolean> {
  let replay = initialData
  return waitForGeneratedAgentInput(
    {
      subscribe: async (observe) => {
        if (isRemoteRuntimePtyId(ptyId)) {
          return subscribeToRuntimeTerminalData(ptyId, `desktop:paste-ready:${ptyId}`, observe)
        }
        const unsubscribe = subscribeToPtyData(ptyId, observe)
        replayPreHandlerPtyData(ptyId, (data) => {
          replay += data
        })
        return unsubscribe
      },
      replay: () => replay,
      accept: (quiet) => agentInputIsAdmitted(ptyId, agent, quiet)
    },
    readySignal,
    {
      timeoutMs,
      signal,
      requireComposerMarker: Boolean(agent && TUI_AGENT_CONFIG[agent].composerReadyCaptures?.length)
    }
  )
}
