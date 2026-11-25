// What the Google write commands return over RPC; the CLI prints them.
import type { CalendarEventSummary } from './google-read-types'

export type GmailDraftView = {
  account: string
  ref: string
  /** The draft's message, for the link that opens it in Gmail. */
  messageRef: string
  threadRef: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  kind: 'new' | 'reply' | 'forward'
  /** True when --draft revised an existing draft. */
  updated: boolean
  attachments: string[]
  link: string
}

export type GmailSendView = {
  account: string
  messageRef: string
  threadRef: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
}

export type GmailModifyView = {
  account: string
  refs: string[]
  added: string[]
  removed: string[]
  /** User labels --add made because they didn't exist yet. */
  created: string[]
}

export type CalendarWriteView = {
  account: string
  now: number
  timeZone: string
  calendar: { id: string; name: string }
  action: 'created' | 'updated' | 'deleted' | 'responded'
  event: CalendarEventSummary
  /** True when the change applied to every occurrence of a repeating event. */
  series: boolean
  /** Who Google emailed about the change; empty with --no-notify or no guests. */
  notified: string[]
  response?: 'accepted' | 'declined' | 'tentative'
  /** A delete cancelled it for everyone (the account organizes it), not just took it off here. */
  cancelled?: boolean
}

export type FreeSlot = { start: string; end: string }

export type CalendarSuggestView = {
  account: string
  now: number
  timeZone: string
  durationMinutes: number
  hours: { from: string; to: string }
  from: string
  to: string
  people: string[]
  /** Calendars Google wouldn't show, and why: those people may be busy in any slot. */
  unknown: { email: string; reason: string }[]
  slots: FreeSlot[]
}
