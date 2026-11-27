import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

const STARTUP_PROMPT_PREVIEW_CHARACTERS = 160
const blockedStartupPrompts = new Map<string, string>()
const blockedStartupToastIds = new Map<string, string>()
let nextBlockedStartupToastId = 0

export function notifyBlockedAgentStartup(
  reason: AgentProgramBlockReason,
  request: string | { worktreeId: string; prompt: string } | undefined
): void {
  if (reason === 'unbuildable') {
    void import('../failure/agent-launch-failure')
      .then(({ notifyAgentLaunchFailure }) => notifyAgentLaunchFailure('hermes'))
      .catch((error: unknown) =>
        console.warn('[terminal] could not show the startup notice', error)
      )
    return
  }
  const title =
    reason === 'unavailable'
      ? translate('terminal.agentStartup.unavailable', 'The agent could not be found on this host.')
      : translate(
          'terminal.agentStartup.unknown',
          'The host could not verify the agent installation.'
        )
  if (typeof request !== 'object') {
    toast.message(title, request ? copyDroppedTextAction(request) : undefined)
    return
  }

  const { worktreeId, prompt } = request
  const id =
    blockedStartupToastIds.get(worktreeId) ?? `blocked-agent-startup:${++nextBlockedStartupToastId}`
  const notDelivered = translate(
    'terminal.startupPromptNotDelivered',
    "The startup prompt wasn't delivered."
  )
  // Build a short independent string so Sonner's history can't retain the prompt via a substring.
  const excerpt = Array.from(prompt.slice(0, STARTUP_PROMPT_PREVIEW_CHARACTERS * 2))
    .slice(0, STARTUP_PROMPT_PREVIEW_CHARACTERS)
    .join('')
  const preview = excerpt.replace(/\s+/g, ' ').trim()
  blockedStartupPrompts.set(id, prompt)
  blockedStartupToastIds.set(worktreeId, id)
  const clearPrompt = (): void => {
    blockedStartupPrompts.delete(id)
    // Retire the ID so another block can show during Sonner's exit animation.
    if (blockedStartupToastIds.get(worktreeId) === id) {
      blockedStartupToastIds.delete(worktreeId)
    }
  }
  toast.message(title, {
    id,
    description: `${notDelivered}\n${preview}${excerpt.length < prompt.length ? '…' : ''}`,
    classNames: { description: 'whitespace-pre-line break-words' },
    duration: Infinity,
    onDismiss: clearPrompt,
    onAutoClose: clearPrompt,
    action: {
      label: translate('menu.copy', 'Copy'),
      onClick: () => {
        const text = blockedStartupPrompts.get(id)
        clearPrompt()
        if (text !== undefined) {
          void window.api.ui.writeClipboardText(text)
        }
      }
    }
  })
}

export function copyDroppedTextAction(text: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('menu.copy', 'Copy'),
      onClick: () => {
        void window.api.ui.writeClipboardText(text)
      }
    }
  }
}
