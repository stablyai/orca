import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

const STARTUP_PROMPT_PREVIEW_CHARACTERS = 160
const STARTUP_PROMPT_PREVIEW_LINES = 4
const MAX_STICKY_STARTUP_NOTICES = 3
const blockedStartupPrompts = new Map<string, string>()
const stickyStartupNotices = new Map<string, () => void>()
let nextBlockedStartupToastId = 0

type StartupDraft = { worktreeId: string; prompt: string } | { creationId: string; prompt: string }

export function notifyBlockedAgentStartup(
  reason: AgentProgramBlockReason,
  request: string | StartupDraft | undefined
): void {
  if (reason === 'unbuildable') {
    void import('../failure/agent-launch-failure')
      .then(({ notifyAgentLaunchFailure }) => notifyAgentLaunchFailure('hermes'))
      .catch((error: unknown) =>
        console.warn('[terminal] could not show the startup notice', error)
      )
    if (typeof request === 'object') {
      showBlockedStartupDraft(request)
    }
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

  showBlockedStartupDraft(request, title)
}

function previewExcerpt(text: string, maxCharacters: number, maxLines: number): string {
  // Build an independent string so Sonner's history can't retain the full draft via a substring.
  const lines = text.slice(0, (maxCharacters + 1) * 2).split(/\r\n?|\n/, maxLines + 1)
  const characters = Array.from(lines.slice(0, maxLines).join('\n'))
  return characters.length > maxCharacters || lines.length > maxLines
    ? `${characters
        .slice(0, maxCharacters - 1)
        .join('')
        .trimEnd()}…`
    : characters.join('')
}

function startupPromptPreview(prompt: string): string {
  const text = prompt.trim()
  const preview = previewExcerpt(
    text,
    STARTUP_PROMPT_PREVIEW_CHARACTERS,
    STARTUP_PROMPT_PREVIEW_LINES
  )
  if (preview === text) {
    return preview
  }

  const lastLineBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
  if (lastLineBreak < 0) {
    return preview
  }
  const lastLine = text.slice(lastLineBreak + 1).trim()
  const url = lastLine.match(/(?:^|\s)(https?:\/\/\S+)$/i)?.[1]
  if (!url) {
    return preview
  }

  const footer = previewExcerpt(lastLine, STARTUP_PROMPT_PREVIEW_CHARACTERS, 1)
  const remaining = STARTUP_PROMPT_PREVIEW_CHARACTERS - Array.from(footer).length - 1
  if (remaining < 1) {
    return previewExcerpt(url, STARTUP_PROMPT_PREVIEW_CHARACTERS, 1)
  }
  const body = text.slice(0, lastLineBreak).trimEnd()
  return `${previewExcerpt(body, remaining, STARTUP_PROMPT_PREVIEW_LINES - 1)}\n${footer}`
}

function showBlockedStartupDraft(request: StartupDraft, title?: string): void {
  const id =
    'creationId' in request
      ? `blocked-agent-startup:create:${request.creationId}`
      : `blocked-agent-startup:launch:${++nextBlockedStartupToastId}`
  const notDelivered = translate(
    'terminal.startupPromptNotDelivered',
    "The startup prompt wasn't delivered."
  )
  const preview = startupPromptPreview(request.prompt)
  const description = title ? `${notDelivered}\n${preview}` : preview
  blockedStartupPrompts.set(id, request.prompt)
  let copying = false
  const clearPrompt = (): void => {
    blockedStartupPrompts.delete(id)
    stickyStartupNotices.delete(id)
  }
  const copyPrompt = async (): Promise<void> => {
    const text = blockedStartupPrompts.get(id)
    if (copying || text === undefined) {
      return
    }
    copying = true
    if (!stickyStartupNotices.has(id)) {
      show()
    }
    try {
      await window.api.ui.writeClipboardText(text)
    } catch {
      copying = false
      if (blockedStartupPrompts.has(id)) {
        show()
      }
      return
    }
    clearPrompt()
    toast.dismiss(id)
  }
  const show = (): void => {
    toast.message(title ?? notDelivered, {
      id,
      description,
      classNames: { description: 'whitespace-pre-line break-words' },
      duration: copying || stickyStartupNotices.has(id) ? Infinity : undefined,
      onDismiss: clearPrompt,
      onAutoClose: clearPrompt,
      action: {
        label: translate('menu.copy', 'Copy'),
        onClick: (event) => {
          // Keep the same toast mounted until we know whether Copy succeeded.
          event.preventDefault()
          void copyPrompt()
        }
      }
    })
  }

  if (stickyStartupNotices.size === MAX_STICKY_STARTUP_NOTICES) {
    const oldest = stickyStartupNotices.entries().next()
    if (!oldest.done) {
      const [oldestId, showOldest] = oldest.value
      stickyStartupNotices.delete(oldestId)
      showOldest()
    }
  }
  stickyStartupNotices.set(id, show)
  show()
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
