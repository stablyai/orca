// Fixtures and DOM lookups shared by the resume dialog's per-machine test files.

import type { RestartOfferOrigin } from '../../../shared/restart-offer-origin'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/** One chat per workspace; each host says whose a chat is for this desktop. */
export function machineRowFixture(sessionId: string, origin: RestartOfferOrigin): ResumeCandidate {
  return {
    sessionId,
    workspaceId: `workspace-${sessionId}`,
    agent: 'codex',
    trigger: 'update',
    latestPrompt: `Prompt ${sessionId}`,
    recordedAt: 1_800_000_000_000,
    executionHostId: 'local',
    workspaceKind: 'git-worktree',
    origin
  }
}

export function machineToggle(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label="Select all chats on ${name}"]`
  )
  if (!found) {
    throw new Error(`Missing machine checkbox: ${name}`)
  }
  return found
}

/** The machine's tree node: its row carries the name, why it stopped, the count and whether it is
 *  open (`aria-expanded`). */
export function machineRow(name: string): HTMLElement {
  const found = machineToggle(name).closest<HTMLElement>('[role="treeitem"]')
  if (!found) {
    throw new Error(`Missing machine row: ${name}`)
  }
  return found
}

/** The arrow that opens or closes the machine's node. */
export function machineDisclosure(name: string): HTMLButtonElement {
  const found = machineRow(name).querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (!found) {
    throw new Error(`Missing machine disclosure: ${name}`)
  }
  return found
}
