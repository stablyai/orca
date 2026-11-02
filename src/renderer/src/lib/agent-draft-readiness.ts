import type { DraftPasteReadySignal } from '../../../shared/tui-agent-config'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { RuledScreen } from '../../../shared/screen-input-veto'
import {
  signalAllowsCompatibilityEvidence,
  waitForGeneratedAgentInput
} from '../../../shared/generated-agent-input-readiness'
import {
  admitsGeneratedInput,
  type GeneratedInputProcess
} from '../../../shared/generated-agent-input-admission'
import { showsAgentComposer } from '../../../shared/agent-input-dialog'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  readPtyBracketedPasteMode,
  readPtyInputScreen
} from '@/components/terminal-pane/pty-buffer-serializer'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData } from '@/components/terminal-pane/pty-pre-handler-buffer'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { getRemoteRuntimePtyOwner } from '@/runtime/runtime-terminal-stream'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// Legacy adapter: only for a paired host older than the generated-input transaction. It applies
// the host's one admission rule to what this client can see; an old host can still open a dialog
// after this read, which no client can prevent.

/** The mounted pane's grid, else the host's own current screen; never a stream posing as one. */
async function readLegacyInputScreen(ptyId: string): Promise<RuledScreen | null> {
  const mounted = await readPtyInputScreen(ptyId)
  if (mounted) {
    return mounted
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    return null
  }
  try {
    const read = await callRuntimeRpc<{ terminal: { tail: string[]; source?: string } }>(
      owner.target,
      'terminal.read',
      { terminal: owner.terminal, screen: true },
      { timeoutMs: 5_000 }
    )
    return read.terminal.source === 'screen'
      ? { lines: read.terminal.tail, alternateScreen: false }
      : null
  } catch {
    return null
  }
}

async function readLegacyProcess(ptyId: string): Promise<GeneratedInputProcess> {
  const process = await inspectRuntimeTerminalProcess(ptyId)
  // An old host's missing evidence is unknown, never a shell or a wrong agent.
  return process.verdict === 'unverifiable' || !process.foregroundProcess
    ? { known: false }
    : {
        known: true,
        foreground: process.foregroundProcess,
        hasChildProcesses: process.hasChildProcesses
      }
}

export async function agentInputIsAdmitted(
  ptyId: string,
  agent?: TuiAgent,
  quiet = false,
  typedText?: string
): Promise<boolean> {
  const process = await readLegacyProcess(ptyId)
  const screen = await readLegacyInputScreen(ptyId)
  return admitsGeneratedInput({ agent, screen, process, quiet, typedText })
}

/** A painted composer with the expected agent proven in front is current positive evidence. */
async function legacyComposerVisible(
  ptyId: string,
  signal: DraftPasteReadySignal,
  agent?: TuiAgent
): Promise<boolean> {
  if (!agent || !signalAllowsCompatibilityEvidence(signal) || !readPtyBracketedPasteMode(ptyId)) {
    return false
  }
  const process = await readLegacyProcess(ptyId)
  const screen = await readLegacyInputScreen(ptyId)
  return (
    process.known &&
    screen !== null &&
    isExpectedAgentProcess(process.foreground, TUI_AGENT_CONFIG[agent].expectedProcess) &&
    showsAgentComposer(screen.lines.join('\n'))
  )
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
      bracketedPaste: () => readPtyBracketedPasteMode(ptyId),
      composerReady: () => legacyComposerVisible(ptyId, readySignal, agent),
      accept: (quiet) => agentInputIsAdmitted(ptyId, agent, quiet)
    },
    readySignal,
    { timeoutMs, signal }
  )
}
