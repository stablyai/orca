import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { findActiveRuntimeTerminal, getActiveTerminalNoteTarget } from './active-agent-note-target'
import type { ActiveTerminalNoteTarget } from './active-agent-note-target'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  getTerminalAgentSendReadiness,
  isRuntimeTerminalUnavailable,
  isRuntimeTimeout
} from './active-agent-terminal-send-readiness'
import {
  codeForReadinessStatus,
  reportNoteSendFailure,
  runtimeFailureCode,
  runtimeFailureFallbackCode
} from './active-agent-note-send-diagnostics'
import {
  sendPromptWithGuardedPasteAndEnter,
  sendPromptWithLegacyCombinedSend
} from './active-agent-note-send-delivery'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Tab } from '../../../shared/tab-types'

export {
  getActiveAgentNoteTarget,
  getActiveAgentRuntimeProbeDescriptor,
  getActiveTerminalNoteTarget,
  probeActiveAgentNoteTarget,
  type ActiveTerminalNoteTarget
} from './active-agent-note-target'
export {
  activeAgentNotesSendFailureMessage,
  type ActiveAgentNotesSendResult,
  type ActiveAgentNotesSendStatus
} from './active-agent-note-send-result'
const ACTIVE_AGENT_SEND_TIMEOUT_MS = 8000

/** When the target tab is showing the chat view, drop the note into the chat
 *  composer as an unsent draft (the user submits it from chat) instead of writing
 *  it to the terminal. Returns null to fall back to the terminal send. `viewMode`
 *  must come from the live unified tab (`getTab`) — the `tabsByWorktree` terminal
 *  record that carries `launchAgent` never sees the chat toggle. */
export function seedNoteAsChatComposerDraft(args: {
  viewMode: Tab['viewMode']
  launchAgent: TuiAgent | undefined
  tabId: string
  text: string
}): ActiveAgentNotesSendResult | null {
  if (
    args.viewMode !== 'chat' ||
    !args.launchAgent ||
    !canMirrorLaunchDraftToNativeChat(args.text)
  ) {
    return null
  }
  seedNativeChatLaunchDraftForAgentTab({
    tabId: args.tabId,
    agent: args.launchAgent,
    text: args.text
  })
  return { status: 'sent' }
}

export async function sendNotesToActiveAgentSession(args: {
  worktreeId: string
  prompt: string
  noteTarget?: ActiveTerminalNoteTarget
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  try {
    return await sendNotesToActiveAgentSessionInternal(args)
  } catch (error) {
    return reportNoteSendFailure(
      { status: 'status-unavailable', code: runtimeFailureFallbackCode(error) },
      args.noteTarget ?? null
    )
  }
}
async function sendNotesToActiveAgentSessionInternal({
  worktreeId,
  prompt,
  noteTarget: explicitNoteTarget,
  timeoutMs
}: {
  worktreeId: string
  prompt: string
  noteTarget?: ActiveTerminalNoteTarget
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    return { status: 'empty', code: 'empty' }
  }
  const state = useAppStore.getState()
  const noteTarget = explicitNoteTarget ?? getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget) {
    return reportNoteSendFailure({ status: 'no-active-terminal', code: 'no-note-target' }, null)
  }
  const terminalTab = (state.tabsByWorktree[worktreeId] ?? []).find(
    (entry) => entry.id === noteTarget.tabId
  )
  const composerDraftResult = seedNoteAsChatComposerDraft({
    viewMode: state.getTab(noteTarget.tabId)?.viewMode,
    launchAgent: terminalTab?.launchAgent,
    tabId: noteTarget.tabId,
    text: trimmedPrompt
  })
  if (composerDraftResult) {
    return reportNoteSendFailure(composerDraftResult, noteTarget)
  }
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  )
  const terminal = await findActiveRuntimeTerminal(
    runtimeTarget,
    worktreeId,
    noteTarget,
    ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS
  )
  if (!terminal) {
    return reportNoteSendFailure(
      { status: 'no-active-terminal', code: 'no-inventory-match' },
      noteTarget
    )
  }
  if (explicitNoteTarget) {
    return reportNoteSendFailure(
      await sendPromptToExplicitAgentTarget(runtimeTarget, terminal.handle, trimmedPrompt),
      noteTarget
    )
  }
  const effectiveTimeoutMs = timeoutMs ?? ACTIVE_AGENT_SEND_TIMEOUT_MS
  const initialAgentStatus = await getTerminalAgentSendReadiness(runtimeTarget, terminal.handle, {
    allowLegacyFallback: true
  })
  if (initialAgentStatus.status !== 'sendable') {
    return reportNoteSendFailure(
      {
        status: initialAgentStatus.status,
        code: initialAgentStatus.code ?? codeForReadinessStatus(initialAgentStatus.status)
      },
      noteTarget
    )
  }
  try {
    const { wait } = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
      runtimeTarget,
      'terminal.wait',
      { terminal: terminal.handle, for: 'tui-idle', timeoutMs: effectiveTimeoutMs },
      { timeoutMs: effectiveTimeoutMs + 5000 }
    )
    if (wait.status !== 'running') {
      return reportNoteSendFailure(
        { status: 'no-active-terminal', code: 'terminal_wait_not_running' },
        noteTarget
      )
    }
    if (wait.blockedReason) {
      return reportNoteSendFailure(
        { status: 'permission', code: 'terminal_wait_blocked' },
        noteTarget
      )
    }
    if (!wait.satisfied) {
      return reportNoteSendFailure(
        { status: 'not-ready', code: 'terminal_wait_unsatisfied' },
        noteTarget
      )
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return reportNoteSendFailure(
        { status: 'no-active-terminal', code: runtimeFailureCode(error) ?? 'runtime-unverifiable' },
        noteTarget
      )
    }
    if (isRuntimeTimeout(error)) {
      return reportNoteSendFailure(
        { status: 'not-ready', code: 'terminal_wait_timeout' },
        noteTarget
      )
    }
    throw error
  }
  const finalAgentStatus = await getTerminalAgentSendReadiness(runtimeTarget, terminal.handle, {
    allowLegacyFallback: true
  })
  if (finalAgentStatus.status !== 'sendable') {
    return reportNoteSendFailure(
      {
        status: finalAgentStatus.status,
        code: finalAgentStatus.code ?? codeForReadinessStatus(finalAgentStatus.status)
      },
      noteTarget
    )
  }

  if (finalAgentStatus.supportsGuardedSend) {
    return reportNoteSendFailure(
      await sendPromptWithGuardedPasteAndEnter(runtimeTarget, terminal.handle, trimmedPrompt, {
        allowLegacyFallback: false
      }),
      noteTarget
    )
  }

  return reportNoteSendFailure(
    await sendPromptWithLegacyCombinedSend(runtimeTarget, terminal.handle, trimmedPrompt),
    noteTarget
  )
}

async function sendPromptToExplicitAgentTarget(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  terminalHandle: string,
  prompt: string
): Promise<ActiveAgentNotesSendResult> {
  return await sendPromptWithGuardedPasteAndEnter(runtimeTarget, terminalHandle, prompt, {
    allowLegacyFallback: false
  })
}
