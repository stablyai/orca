// Fixtures and DOM lookups shared by the resume dialog's test files.

import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

export const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000,
  executionHostId: 'local',
  workspaceKind: 'git-worktree',
  origin: 'own'
}))

/** A chat the host acted on and could not carry on, as it reports it. */
export function failure(sessionId: string, reason = 'agent_session_restart_work_superseded') {
  const candidate = offered.find((entry) => entry.sessionId === sessionId)!
  return { ...candidate, failedAt: candidate.recordedAt + 60_000, outcome: 'refused', reason }
}

export function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text || entry.getAttribute('aria-label') === text
  )
  if (!found) {
    throw new Error(`Missing button: ${text}`)
  }
  return found
}

/** A chat's own checkbox; its accessible name carries the prompt. */
export function chatBox(sessionId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label*="Prompt ${sessionId}"]`
  )
  if (!found) {
    throw new Error(`Missing chat checkbox: ${sessionId}`)
  }
  return found
}

export function chatBoxes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="checkbox"][aria-label^="Resume "]')]
}

export function namedBox(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${name}"]`)
  if (!found) {
    throw new Error(`Missing checkbox: ${name}`)
  }
  return found
}

export function dontAskAgain(): HTMLElement {
  const found = [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.includes("Don't ask again"))
    ?.querySelector<HTMLElement>('[role="checkbox"]')
  if (!found) {
    throw new Error('Missing Don’t ask again checkbox')
  }
  return found
}
