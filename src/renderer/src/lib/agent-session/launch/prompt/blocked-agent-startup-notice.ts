import { XIcon } from 'lucide-react'
import { createElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

const STARTUP_PROMPT_PREVIEW_CHARACTERS = 160
const STARTUP_PROMPT_PREVIEW_LINES = 4
const STARTUP_PROMPT_PREVIEW_URL_CHARACTERS = 64
const BLOCKED_STARTUP_DRAFTS_TOAST_ID = 'blocked-startup-drafts'
const MAX_BLOCKED_STARTUP_DRAFTS = 3
const blockedStartupDrafts: { reason: AgentProgramBlockReason; prompt: string }[] = []
let copyingDraft = false
let dismissingDraftNotice = false

type StartupDraft = { worktreeId: string; prompt: string } | { creationId: string; prompt: string }

export function notifyBlockedAgentStartup(
  reason: AgentProgramBlockReason,
  request: string | StartupDraft | undefined
): void {
  if (typeof request === 'object') {
    blockedStartupDrafts.unshift({ reason, prompt: request.prompt })
    // Keep only the three latest drafts. Each replaces the preview as it arrives.
    if (blockedStartupDrafts.length > MAX_BLOCKED_STARTUP_DRAFTS) {
      blockedStartupDrafts.pop()
    }
    showBlockedStartupDraftNotice()
    return
  }

  if (reason === 'unbuildable') {
    void import('../failure/agent-launch-failure')
      .then(({ notifyAgentLaunchFailure }) => notifyAgentLaunchFailure('hermes'))
      .catch((error: unknown) =>
        console.warn('[terminal] could not show the startup notice', error)
      )
    return
  }
  toast.message(blockedStartupTitle(reason), request ? copyDroppedTextAction(request) : undefined)
}

function blockedStartupTitle(reason: AgentProgramBlockReason): string {
  switch (reason) {
    case 'unbuildable':
      return translate(
        'components.agentSessionContinuation.launchFailed',
        'Could not start a new {{agent}} session.',
        { agent: translate('auto.lib.agent.catalog.8a9ba743cc', 'Hermes') }
      )
    case 'unavailable':
      return translate(
        'terminal.agentStartup.unavailable',
        'The agent could not be found on this host.'
      )
    case 'unknown':
      return translate(
        'terminal.agentStartup.unknown',
        'The host could not verify the agent installation.'
      )
  }
}

function previewExcerpt(text: string, maxCharacters: number, maxLines: number): string {
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

  const trailingUrl = /(?:^|\s)(https?:\/\/\S+)$/i.exec(text)
  if (!trailingUrl?.[1]) {
    return preview
  }

  const body = text.slice(0, trailingUrl.index).trimEnd()
  const footer = shortenPreviewUrl(trailingUrl[1])
  if (!body) {
    return footer
  }
  const remaining = STARTUP_PROMPT_PREVIEW_CHARACTERS - Array.from(footer).length - 1
  return `${previewExcerpt(body, remaining, STARTUP_PROMPT_PREVIEW_LINES - 1)}\n${footer}`
}

function shortenPreviewUrl(url: string): string {
  const limit = STARTUP_PROMPT_PREVIEW_URL_CHARACTERS
  const start = Array.from(url.slice(0, limit * 2))
  if (url.length <= limit * 2 && start.length <= limit) {
    return url
  }
  const headLength = Math.floor(limit / 2)
  const tailLength = limit - headLength - 1
  const end = Array.from(url.slice(-tailLength * 2))
  return `${start.slice(0, headLength).join('')}…${end.slice(-tailLength).join('')}`
}

function BlockedStartupDraftDescription(): ReturnType<typeof createElement> {
  const draft = blockedStartupDrafts[0]
  const moreCount = blockedStartupDrafts.length - 1
  const notDelivered = translate(
    'terminal.startupPromptNotDelivered',
    "The startup prompt wasn't delivered."
  )
  const more =
    moreCount > 0
      ? translate('terminal.startupPromptMore', '({{count}} more)', { count: moreCount })
      : null
  return createElement(
    'div',
    { ref: finishBlockedStartupDraftDismissal },
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': translate('auto.components.ui.dialog.f26c4baeda', 'Close'),
        'data-close-button': true,
        onClick: () => {
          if (draft && blockedStartupDrafts[0] === draft) {
            blockedStartupDrafts.shift()
            refreshBlockedStartupDraftNotice()
          }
        }
      },
      createElement(XIcon, { className: 'size-3', 'aria-hidden': true })
    ),
    createElement('div', null, notDelivered, more && ` ${more}`),
    createElement(
      'div',
      { className: 'line-clamp-4 whitespace-pre-wrap wrap-anywhere' },
      draft ? startupPromptPreview(draft.prompt) : null
    )
  )
}

function BlockedStartupDraftCopyButton(): ReturnType<typeof createElement> {
  const draft = blockedStartupDrafts[0]
  return createElement(
    'button',
    {
      type: 'button',
      'data-button': true,
      'data-action': true,
      onClick: () => {
        if (draft && blockedStartupDrafts[0] === draft) {
          void copyStartupDraft(draft)
        }
      }
    },
    translate('menu.copy', 'Copy')
  )
}

function showBlockedStartupDraftNotice(): void {
  if (blockedStartupDrafts.length === 0 || dismissingDraftNotice) {
    return
  }
  // Sonner's message API replaces the history record for this id.
  toast.message(
    () => {
      const draft = blockedStartupDrafts[0]
      return draft ? blockedStartupTitle(draft.reason) : null
    },
    {
      id: BLOCKED_STARTUP_DRAFTS_TOAST_ID,
      description: createElement(BlockedStartupDraftDescription),
      duration: Infinity,
      closeButton: false,
      dismissible: false,
      action: createElement(BlockedStartupDraftCopyButton)
    }
  )
}

function refreshBlockedStartupDraftNotice(): void {
  if (blockedStartupDrafts.length > 0) {
    showBlockedStartupDraftNotice()
  } else {
    dismissingDraftNotice = true
    toast.dismiss(BLOCKED_STARTUP_DRAFTS_TOAST_ID)
  }
}

function finishBlockedStartupDraftDismissal(element: HTMLDivElement | null): void {
  if (element === null && dismissingDraftNotice) {
    // Sonner removes the old card after its exit animation, even if its id was updated.
    dismissingDraftNotice = false
    if (blockedStartupDrafts.length > 0) {
      queueMicrotask(showBlockedStartupDraftNotice)
    }
  }
}

async function copyStartupDraft(draft: (typeof blockedStartupDrafts)[number]): Promise<void> {
  if (copyingDraft) {
    return
  }
  copyingDraft = true
  try {
    await window.api.ui.writeClipboardText(draft.prompt)
  } catch {
    return
  } finally {
    copyingDraft = false
  }
  const index = blockedStartupDrafts.indexOf(draft)
  if (index !== -1) {
    blockedStartupDrafts.splice(index, 1)
    refreshBlockedStartupDraftNotice()
  }
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
