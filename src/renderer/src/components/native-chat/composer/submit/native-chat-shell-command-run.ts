import { translate } from '@/i18n/i18n'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

/**
 * Runs a `!` command in a new terminal tab of the chat's workspace, as the new-tab button would.
 * Why a terminal: it already resolves the workspace's host (local, SSH, WSL, paired), its cwd and
 * the login shell, and it lets interactive commands prompt. The output stays in that terminal and
 * never reaches the agent or the chat transcript, so a command that prints a secret leaks nothing.
 */
export function runNativeChatShellCommand(worktreeId: string, command: string): Promise<boolean> {
  return new Promise((resolve) => {
    createNewTerminalTab(worktreeId, undefined, { command, onSettled: resolve })
  })
}

/** Runs a structured chat's `!` draft; false, with a composer notice, when it did not start. */
export async function runNativeChatShellDraft(
  transport: Pick<NativeChatStructuredComposerTransport, 'onError'>,
  worktreeId: string,
  command: string,
  attachments: readonly unknown[]
): Promise<boolean> {
  if (attachments.length > 0) {
    transport.onError(
      translate(
        'components.native-chat.composer.shellCommandAttachmentsUnsupported',
        'Remove attachments before running a ! command.'
      )
    )
    return false
  }
  if (!(await runNativeChatShellCommand(worktreeId, command))) {
    transport.onError(
      translate(
        'components.native-chat.composer.shellCommandFailed',
        'Could not start the ! command in a terminal.'
      )
    )
    return false
  }
  transport.onError(null)
  return true
}
