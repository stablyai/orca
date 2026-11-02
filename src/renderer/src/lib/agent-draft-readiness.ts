import type { DraftPasteReadySignal } from '../../../shared/tui-agent-config'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  signalAllowsCompatibilityEvidence,
  waitForGeneratedAgentInput,
  type GeneratedInputIntent
} from '../../../shared/generated-agent-input-readiness'
import { stripAnsiEscapeSequences } from '../../../shared/ansi-escape-sequences'
import {
  admitsGeneratedInput,
  type GeneratedInputProcess,
  type GeneratedInputScreen
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

/**
 * The one decision point for a legacy host that offers no observation at all: no mounted pane, no
 * screen from the host and no streamed text since the agent's last handoff. 'deliver' keeps main's
 * behavior and the common pattern's unknown-endpoint rule (any dialog seen anywhere still vetoes);
 * 'refuse' waits out the budget and offers Copy instead. Pending coordinator decision.
 */
export const LEGACY_BLIND_POLICY: 'deliver' | 'refuse' = 'deliver'

type LegacyEvidence = { screen: GeneratedInputScreen; grid: boolean }

// Text an older host streamed to this client since the agent's last handoff, per PTY. It is veto
// and marker evidence only, never a grid; each legacy delivery clears it when it ends.
const legacyTails = new Map<string, string>()
const LEGACY_TAIL_CHARS = 8 * 1024
// oxlint-disable-next-line no-control-regex -- PTY mode resets end the agent's current input region.
const LEGACY_HANDOFF = /\x1b\[\?(?:2004|2031|1049)l/g

function observeLegacyTail(ptyId: string, data: string): void {
  const handoffs = [...data.matchAll(LEGACY_HANDOFF)]
  const last = handoffs.at(-1)
  const text = stripAnsiEscapeSequences(
    last ? data.slice(last.index + last[0].length) : data
  ).replace(/\r\n?/g, '\n')
  const kept = last ? text : (legacyTails.get(ptyId) ?? '') + text
  legacyTails.set(ptyId, kept.slice(-LEGACY_TAIL_CHARS))
}

export function forgetLegacyTail(ptyId: string): void {
  legacyTails.delete(ptyId)
}

/** The mounted pane's grid, else the host's own screen, else the streamed tail as veto evidence;
 *  with none of them, the blind policy decides. */
async function readLegacyEvidence(ptyId: string): Promise<LegacyEvidence> {
  const mounted = await readPtyInputScreen(ptyId)
  if (mounted) {
    return { screen: mounted, grid: true }
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (owner) {
    try {
      const read = await callRuntimeRpc<{ terminal: { tail: string[]; source?: string } }>(
        owner.target,
        'terminal.read',
        { terminal: owner.terminal, screen: true },
        { timeoutMs: 5_000 }
      )
      if (read.terminal.source === 'screen') {
        return { screen: { lines: read.terminal.tail, alternateScreen: false }, grid: true }
      }
    } catch {
      // An unanswered read is no observation; the tail or blind policy decides below.
    }
  }
  const tail = legacyTails.get(ptyId)
  if (tail?.trim()) {
    return { screen: { lines: tail.split('\n'), alternateScreen: false }, grid: false }
  }
  return { screen: LEGACY_BLIND_POLICY === 'deliver' ? 'unknown' : null, grid: false }
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
  const { screen } = await readLegacyEvidence(ptyId)
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
  const { screen, grid } = await readLegacyEvidence(ptyId)
  // Only a grid can show a painted composer; streamed text is veto evidence alone.
  return (
    process.known &&
    grid &&
    screen !== null &&
    screen !== 'unknown' &&
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
  initialData = '',
  intent: GeneratedInputIntent = 'startup'
): Promise<boolean> {
  let replay = initialData
  return waitForGeneratedAgentInput(
    {
      subscribe: async (onData) => {
        const observe = (data: string): void => {
          observeLegacyTail(ptyId, data)
          onData(data)
        }
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
    { timeoutMs, signal, intent }
  )
}
