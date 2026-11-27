import { XIcon } from 'lucide-react'
import { createElement, useLayoutEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

const STARTUP_PROMPT_PREVIEW_CHARACTERS = 160
const STARTUP_PROMPT_PREVIEW_LINES = 4
const STARTUP_PROMPT_PREVIEW_URL_CHARACTERS = 64
const BLOCKED_STARTUP_DRAFTS_TOAST_ID = 'blocked-startup-drafts'
const MAX_BLOCKED_STARTUP_DRAFTS = 3
type StartupDraft = { prompt: string }
type StartupDraftPreview = { reason: AgentProgramBlockReason; preview: string }
type BlockedStartupDraft = StartupDraft & StartupDraftPreview

let blockedStartupDrafts: readonly BlockedStartupDraft[] = []
const draftListeners = new Set<() => void>()
let copyingDraft = false
let draftNoticeMounted = false
let dismissingDraftNotice = false

function subscribeToStartupDrafts(listener: () => void): () => void {
  draftListeners.add(listener)
  return () => {
    draftListeners.delete(listener)
  }
}

function getStartupDrafts(): readonly BlockedStartupDraft[] {
  return blockedStartupDrafts
}

function setStartupDrafts(drafts: readonly BlockedStartupDraft[]): void {
  blockedStartupDrafts = drafts
  for (const listener of draftListeners) {
    listener()
  }
}

export function notifyBlockedAgentStartup<Draft extends StartupDraft>(
  reason: AgentProgramBlockReason,
  request: string | Draft | undefined
): void {
  if (reason === 'unbuildable') {
    void import('../failure/agent-launch-failure')
      .then(({ notifyAgentLaunchFailure }) => notifyAgentLaunchFailure('hermes'))
      .catch((error: unknown) =>
        console.warn('[terminal] could not show the startup notice', error)
      )
  }

  if (typeof request === 'object') {
    const { prompt } = request
    setStartupDrafts(
      [{ reason, prompt, preview: startupPromptPreview(prompt) }, ...blockedStartupDrafts].slice(
        0,
        MAX_BLOCKED_STARTUP_DRAFTS
      )
    )
    if (draftNoticeMounted) {
      dismissBlockedStartupDraftNotice()
    } else {
      showBlockedStartupDraftNotice()
    }
  } else if (reason !== 'unbuildable') {
    toast.message(blockedStartupTitle(reason), request ? copyDroppedTextAction(request) : undefined)
  }
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

  const tailStart = Math.max(0, text.length - STARTUP_PROMPT_PREVIEW_CHARACTERS * 2)
  const trailingUrl = /(?:^|\s)(https?:\/\/\S+)$/i.exec(text.slice(tailStart))
  const url = trailingUrl?.[1]
  if (!url) {
    return preview
  }

  const urlStart = text.length - url.length
  if (urlStart === tailStart && tailStart > 0 && !/\s/.test(text.charAt(tailStart - 1))) {
    return preview
  }

  const body = text.slice(0, urlStart).trimEnd()
  const footer = shortenPreviewUrl(url)
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
    return start.join('')
  }
  const headLength = Math.floor(limit / 2)
  const tailLength = limit - headLength - 1
  const end = Array.from(url.slice(-tailLength * 2))
  return `${start.slice(0, headLength).join('')}…${end.slice(-tailLength).join('')}`
}

function BlockedStartupDraftText({
  reason,
  preview,
  moreCount
}: StartupDraftPreview & { moreCount: number }): ReturnType<typeof createElement> {
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
    { className: 'flex flex-col gap-1.5' },
    createElement('div', { 'data-title': '' }, blockedStartupTitle(reason)),
    createElement(
      'div',
      { 'data-description': '' },
      createElement('div', null, notDelivered, more && ` ${more}`),
      createElement('div', { className: 'line-clamp-4 whitespace-pre-wrap wrap-anywhere' }, preview)
    )
  )
}

function BlockedStartupDraftNotice(): ReturnType<typeof createElement> | null {
  const drafts = useSyncExternalStore(subscribeToStartupDrafts, getStartupDrafts)
  useLayoutEffect(() => {
    draftNoticeMounted = true
    if (getStartupDrafts().length === 0) {
      dismissBlockedStartupDraftNotice()
    }
    return () => {
      draftNoticeMounted = false
      if (dismissingDraftNotice) {
        // Recreate after Sonner removes the old card so this id returns at the front of the stack.
        queueMicrotask(() => {
          if (!draftNoticeMounted && dismissingDraftNotice) {
            dismissingDraftNotice = false
            showBlockedStartupDraftNotice()
          }
        })
      }
    }
  }, [])
  const draft = drafts[0]
  if (!draft) {
    return null
  }
  const moreCount = drafts.length - 1
  // Sonner measures the card on mount. Reserve room for the drafts this card advances through.
  const sizingDrafts = drafts.map(({ reason, preview }, index) =>
    createElement(
      'div',
      { key: index, className: 'invisible col-start-1 row-start-1', 'aria-hidden': true },
      createElement(BlockedStartupDraftText, { reason, preview, moreCount })
    )
  )
  return createElement(
    'div',
    { className: 'flex flex-col gap-2.5' },
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': translate('auto.components.ui.dialog.f26c4baeda', 'Close'),
        'data-close-button': true,
        onClick: () => {
          if (blockedStartupDrafts[0] === draft) {
            removeStartupDraft(draft)
          }
        }
      },
      createElement(XIcon, { className: 'size-3', 'aria-hidden': true })
    ),
    createElement(
      'div',
      { className: 'grid' },
      sizingDrafts,
      createElement(
        'div',
        { className: 'col-start-1 row-start-1' },
        createElement(BlockedStartupDraftText, {
          reason: draft.reason,
          preview: draft.preview,
          moreCount
        })
      )
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'self-start',
        'data-button': true,
        'data-action': true,
        onClick: () => {
          if (blockedStartupDrafts[0] === draft) {
            void copyStartupDraft(draft)
          }
        }
      },
      translate('menu.copy', 'Copy')
    )
  )
}

function showBlockedStartupDraftNotice(): void {
  if (blockedStartupDrafts.length === 0 || dismissingDraftNotice) {
    return
  }
  toast.message(createElement(BlockedStartupDraftNotice), {
    id: BLOCKED_STARTUP_DRAFTS_TOAST_ID,
    classNames: { title: 'contents' },
    duration: Infinity,
    closeButton: false,
    dismissible: false
  })
}

function dismissBlockedStartupDraftNotice(): void {
  if (draftNoticeMounted && !dismissingDraftNotice) {
    dismissingDraftNotice = true
    toast.dismiss(BLOCKED_STARTUP_DRAFTS_TOAST_ID)
  }
}

function removeStartupDraft(draft: BlockedStartupDraft): void {
  const drafts = blockedStartupDrafts.filter((queuedDraft) => queuedDraft !== draft)
  if (drafts.length === blockedStartupDrafts.length) {
    return
  }
  setStartupDrafts(drafts)
  if (drafts.length === 0) {
    dismissBlockedStartupDraftNotice()
  }
}

async function copyStartupDraft(draft: BlockedStartupDraft): Promise<void> {
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
  removeStartupDraft(draft)
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
