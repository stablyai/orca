import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentProgramBlockReason } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { startupPromptPreview } from './startup-prompt-preview'

const MAX_BLOCKED_STARTUP_DRAFTS = 3
type StartupDraft = { prompt: string }
type BlockedStartupDraft = { id: number; reason: AgentProgramBlockReason; preview: string }

let blockedStartupDrafts: readonly BlockedStartupDraft[] = []
const startupDraftTexts = new Map<number, string>()
let nextDraftId = 0
const draftListeners = new Set<() => void>()
let copyingDraft = false

export function subscribeToStartupDrafts(listener: () => void): () => void {
  draftListeners.add(listener)
  return () => {
    draftListeners.delete(listener)
  }
}

export function getStartupDrafts(): readonly BlockedStartupDraft[] {
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
    const id = nextDraftId++
    const drafts = [{ id, reason, preview: startupPromptPreview(prompt) }, ...blockedStartupDrafts]
    const evicted = drafts.length > MAX_BLOCKED_STARTUP_DRAFTS ? drafts.pop() : undefined
    if (evicted) {
      startupDraftTexts.delete(evicted.id)
    }
    startupDraftTexts.set(id, prompt)
    setStartupDrafts(drafts)
  } else if (reason !== 'unbuildable') {
    toast.message(blockedStartupTitle(reason), request ? copyDroppedTextAction(request) : undefined)
  }
}

export function blockedStartupTitle(reason: AgentProgramBlockReason): string {
  switch (reason) {
    case 'unbuildable':
      return translate('terminal.startupPromptNotDelivered', "The startup prompt wasn't delivered.")
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

export function closeStartupDraft(id: number): void {
  const drafts = blockedStartupDrafts.filter((draft) => draft.id !== id)
  if (drafts.length === blockedStartupDrafts.length) {
    return
  }
  startupDraftTexts.delete(id)
  setStartupDrafts(drafts)
}

export async function copyStartupDraft(id: number): Promise<void> {
  if (copyingDraft) {
    return
  }
  const prompt = startupDraftTexts.get(id)
  if (prompt === undefined) {
    return
  }
  copyingDraft = true
  try {
    await window.api.ui.writeTerminalClipboardText(prompt)
  } catch {
    return
  } finally {
    copyingDraft = false
  }
  closeStartupDraft(id)
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
