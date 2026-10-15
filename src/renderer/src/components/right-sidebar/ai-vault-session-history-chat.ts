// Whether an Agent Session History row can open as a read-only chat tab, and that tab's identity.
//
// Kept free of store imports so the eligibility gates (`ai-vault-session-resume-in-chat*`) can
// call it during render without widening their module graph; the store-touching opener lives in
// ai-vault-session-history-chat-open.ts.

import type { AiVaultSession } from '../../../../shared/ai-vault-types'

/** The tab id a history chat paints under; stable so reopening focuses the existing tab. */
export function aiVaultSessionHistoryChatTabId(sessionId: string): string {
  return `ai-vault-history-chat-${sessionId}`
}

/** Whether this row's conversation can render as a read-only chat tab today: an agent whose
 *  transcripts the chat reads through its own store, with no structured chat already open.
 *  ZCode is also a structured agent now, so a row the host adopted goes to the structured chat;
 *  an unadopted one routes between the live adoption and this read-only tab through the
 *  resume-in-chat eligibility gate, which decides on the row's storage and host. */
export function canOpenAiVaultSessionHistoryChat(session: {
  agent: AiVaultSession['agent']
  structuredSession?: AiVaultSession['structuredSession']
}): boolean {
  return session.agent === 'zcode' && !session.structuredSession
}
