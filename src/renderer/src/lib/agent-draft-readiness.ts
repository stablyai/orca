import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import {
  admitsGeneratedInput,
  type GeneratedInputProcess
} from '../../../shared/generated-agent-input-admission'
import {
  gridShowsReadyComposer,
  type GeneratedInputEvidence
} from '../../../shared/generated-input-readiness-evaluation'
import { waitForGeneratedAgentInput } from '../../../shared/generated-agent-input-readiness'
import { resolvePasteReadySignal } from '../../../shared/draft-paste-ready-scanner'
import type { GeneratedInputSource } from '../../../shared/generated-input-operation'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  readPtyBracketedPasteMode,
  readPtyInputScreen
} from '@/components/terminal-pane/pty-buffer-serializer'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData } from '@/components/terminal-pane/pty-pre-handler-buffer'
import { acquireTerminalPtyInputTurn } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  getRemoteRuntimePtyOwner,
  subscribeToRuntimeTerminalData
} from '@/runtime/runtime-terminal-stream'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  GeneratedInputAttempt,
  GeneratedInputSelection
} from '@/runtime/generated-input-attempt'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'

// Legacy source: only for a paired host older than the generated-input operation. It reports what
// this client can see of that host's terminal and writes through the existing input route; the
// shared operation decides. An old host can still open a dialog after the last read, which no
// client can prevent.

const HOST_SCREEN_READ_TIMEOUT_MS = 5_000
let observationSeq = 0

async function readLegacyProcess(
  ptyId: string,
  selection: GeneratedInputSelection | undefined
): Promise<GeneratedInputProcess> {
  const process = await inspectRuntimeTerminalProcess(
    ptyId,
    selection ? { selectedPairingRevision: selection.pairingRevision } : undefined
  )
  // An old host's missing evidence is unknown, never a shell or a wrong agent.
  return process.verdict === 'unverifiable' || !process.foregroundProcess
    ? { known: false }
    : {
        known: true,
        foreground: process.foregroundProcess,
        hasChildProcesses: process.hasChildProcesses
      }
}

/** The mounted pane's grid, else the host's own screen; 'unknown' otherwise (the operation's own
 *  streamed tail and the blind policy take it from there). */
async function readLegacyEvidence(
  ptyId: string,
  /** The status this request already selected for the host: its reads do not ask for it again,
   *  and go only to the pairing it was selected on. */
  selection: GeneratedInputSelection | undefined
): Promise<GeneratedInputEvidence> {
  const process = await readLegacyProcess(ptyId, selection)
  const mounted = await readPtyInputScreen(ptyId)
  if (mounted) {
    return { screen: mounted, process, bracketedPaste: readPtyBracketedPasteMode(ptyId) }
  }
  // Only a paired host's PTY has a host screen to ask for; a local one is never legacy.
  const owner = isRemoteRuntimePtyId(ptyId) ? getRemoteRuntimePtyOwner(ptyId) : null
  if (owner) {
    try {
      const read = await callRuntimeRpc<{ terminal: { tail: string[]; source?: string } }>(
        owner.target,
        'terminal.read',
        { terminal: owner.terminal, screen: true },
        {
          timeoutMs: HOST_SCREEN_READ_TIMEOUT_MS,
          ...(selection
            ? {
                skipCompatibilityCheck: true,
                expectedEnvironmentPairingRevision: selection.pairingRevision
              }
            : {})
        }
      )
      if (read.terminal.source === 'screen') {
        return {
          screen: { lines: read.terminal.tail, alternateScreen: false },
          process,
          bracketedPaste: null
        }
      }
      // Only streamed text: never a grid, but a dialog it shows still refuses.
      const tail = read.terminal.tail.join('\n')
      if (tail.trim()) {
        return { screen: 'unknown', process, bracketedPaste: null, tail }
      }
    } catch (error) {
      // Its selected pairing was retired: this attempt ends, no other pairing's screen stands in.
      if (error instanceof RuntimeRpcCallError && error.code === 'runtime_environment_changed') {
        throw error
      }
      // An unanswered read is no observation.
    }
  }
  return { screen: 'unknown', process, bracketedPaste: null }
}

/** One generated write's legacy source for `ptyId`. */
export function createLegacyGeneratedInputSource(args: {
  ptyId: string
  content: string
  agent?: TuiAgent | null
  inputKind: TerminalInputKind
  /** The window's accepted request these writes carry; its runtime settles it as they happen. */
  operationId?: string
  /** That request's own end and the route it selected; every frame spends and keeps them. */
  attempt?: GeneratedInputAttempt
  /** That request's caller cancellation. */
  signal?: AbortSignal
}): GeneratedInputSource {
  const { ptyId, content, inputKind } = args
  let replay = ''
  const write = async (
    gate: Parameters<GeneratedInputSource['writeText']>[0],
    data: string
  ): Promise<boolean> => {
    // Progress starts only as these bytes are actually handed to IPC, after every wait before it;
    // a request that ended meanwhile refuses there, so nothing of it leaves later.
    let taken: ((written: boolean | 'unknown') => void) | undefined
    try {
      const accepted = await sendRuntimePtyInputVerified(ptyId, data, inputKind, {
        ...(args.operationId ? { generatedInputOperationId: args.operationId } : {}),
        ...(args.attempt ? { attempt: args.attempt } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        beforeSend: () => {
          taken = gate.dispatching()
        }
      })
      taken?.(accepted)
      return accepted
    } catch {
      // A lost answer may have been written: it stays unconfirmed, never retried. Never handed
      // over, nothing was.
      taken?.('unknown')
      return false
    }
  }
  const retryDelayMs = args.agent ? TUI_AGENT_CONFIG[args.agent]?.submitRetryDelayMs : undefined
  return {
    observe: (onData) => {
      if (isRemoteRuntimePtyId(ptyId)) {
        observationSeq += 1
        return subscribeToRuntimeTerminalData(
          ptyId,
          `desktop:generated-input:${ptyId}:${observationSeq}`,
          onData
        )
      }
      const dispose = subscribeToPtyData(ptyId, onData)
      replayPreHandlerPtyData(ptyId, (data) => {
        replay += data
      })
      return dispose
    },
    replay: () => replay,
    acquire: (signal) => acquireTerminalPtyInputTurn(ptyId, signal),
    read: () => {
      const selection = args.attempt?.selection
      return readLegacyEvidence(
        ptyId,
        selection &&
          selection.environmentId === getRemoteRuntimePtyOwner(ptyId)?.target.environmentId
          ? selection
          : undefined
      )
    },
    enterReserveMs: 0,
    writeText: async (gate) => {
      let wrote = false
      return await sendAgentDraftPasteContentNow(ptyId, content, inputKind, async (data) => {
        // After the first frame its own rows are composer text, not a dialog.
        if (!(await gate.admit(wrote ? content : undefined))) {
          return false
        }
        wrote = true
        return await write(gate, data)
      })
    },
    // Defer Enter so the agent processes the paste's end before submission.
    settle: (signal) => delay(AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS, signal),
    writeEnter: async (gate) => (await gate.admit(content)) && (await write(gate, '\r')),
    ...(retryDelayMs === undefined
      ? {}
      : {
          // Some composers render before accepting Enter; one best-effort retry.
          retry: async (gate, signal) => {
            await delay(retryDelayMs, signal)
            if (await gate.admit(content)) {
              await write(gate, '\r')
            }
          }
        })
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** Before held keys are handed to the operation: when this pane's own agent looks ready to take
 *  them. Timing only; the operation that receives them observes and admits on its own. */
export function waitForPaneAgentToLookReady(
  ptyId: string,
  agent: TuiAgent,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  let replay = ''
  const readySignal = resolvePasteReadySignal(TUI_AGENT_CONFIG[agent], false)
  const evidence = async (): Promise<GeneratedInputEvidence> => {
    const screen = await readPtyInputScreen(ptyId)
    return {
      screen: screen ?? 'unknown',
      process: { known: false },
      bracketedPaste: screen ? readPtyBracketedPasteMode(ptyId) : null
    }
  }
  return waitForGeneratedAgentInput(
    {
      subscribe: (onData) => {
        const dispose = subscribeToPtyData(ptyId, onData)
        replayPreHandlerPtyData(ptyId, (data) => {
          replay += data
        })
        return dispose
      },
      replay: () => replay,
      bracketedPaste: () => readPtyBracketedPasteMode(ptyId),
      composerReady: async (quietMs) =>
        gridShowsReadyComposer(await evidence(), agent, readySignal, quietMs),
      accept: async (quiet) => {
        const { screen, process } = await evidence()
        return admitsGeneratedInput({ agent, screen, process, quiet })
      }
    },
    readySignal,
    { timeoutMs, signal, intent: 'startup' }
  )
}
