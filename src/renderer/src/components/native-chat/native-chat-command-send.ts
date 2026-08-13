import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../shared/agent-tui-command-typing'
import { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } from './native-chat-send'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import {
  runtimeNativeChatPtyWriter,
  type NativeChatPtyWriter,
  type NativeChatRuntimeSettings
} from './native-chat-pty-writer'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

function clearCommandInput(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  writer: NativeChatPtyWriter
): void {
  writer.write(settings, ptyId, NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
}

/** Types a slash command as individual keys so Codex opens its command palette. */
export async function typeNativeChatCommand(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  command: string,
  signal?: AbortSignal,
  writer: NativeChatPtyWriter = runtimeNativeChatPtyWriter
): Promise<boolean> {
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  const outcome = await typeAgentTuiCommand({
    command,
    signal,
    write: async (key) =>
      (await writer.writeAccepted(settings, ptyId, key).catch(() => false))
        ? 'accepted'
        : 'rejected'
  })
  return outcome === 'accepted'
}

/** Queues a typed slash command with composer sends on the same PTY. */
export function sendNativeChatTypedCommand(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  command: string,
  writer: NativeChatPtyWriter = runtimeNativeChatPtyWriter
): NativeChatSendHandle {
  const controller = new AbortController()
  let accepted = false
  const handle = enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        accepted = !isCancelled() && outcome === 'accepted'
        if (!isCancelled() && outcome !== 'accepted') {
          clearCommandInput(settings, ptyId, writer)
        }
        markSubmitted()
      }
      void typeAgentTuiCommand({
        command,
        signal: controller.signal,
        write: async (key) => {
          if (isCancelled()) {
            return 'rejected'
          }
          return (await writer.writeAccepted(settings, ptyId, key).catch(() => false))
            ? 'accepted'
            : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      onCancelUnsubmitted: () => {
        controller.abort()
        clearCommandInput(settings, ptyId, writer)
      }
    }
  )
  return writer.requiresWriteAcceptance
    ? { ...handle, delivered: handle.settled.then(() => accepted) }
    : handle
}
