// What the Google read commands return over RPC; the CLI prints them, fencing every third-party text.

export type GmailThreadSummary = {
  ref: string
  subject: string
  /** The latest message's sender. */
  from: string
  at: number
  snippet: string
  messages: number
  unread: boolean
}

export type GmailSearchView = {
  account: string
  /** Gmail's own "about N" estimate. */
  estimate?: number
  nextPageToken?: string
  threads: GmailThreadSummary[]
}

export type GmailAttachment = { ref: string; name: string; type?: string; size?: number }

export type GmailMessageView = {
  ref: string
  from: string
  to: string
  cc?: string
  at: number
  body: string
  /** Set when only part of this body is on the page: its character range and length. */
  part?: { from: number; to: number; of: number }
  attachments: GmailAttachment[]
}

export type GmailReadView = {
  account: string
  ref: string
  subject: string
  messages: GmailMessageView[]
  /** Where `--offset` picks up the bodies when there is more. */
  nextOffset?: number
}

export type CalendarAttendee = {
  email: string
  name?: string
  response: 'accepted' | 'declined' | 'tentative' | 'needsAction'
  organizer?: boolean
  self?: boolean
}

export type CalendarEventSummary = {
  ref: string
  title: string
  /** RFC 3339, or a date for an all-day event. */
  start: string
  end: string
  allDay: boolean
  location?: string
  meetUrl?: string
  attendees: CalendarAttendee[]
  /** This occurrence belongs to a repeating event. */
  recurring: boolean
  status?: string
}

export type CalendarListView = {
  account: string
  /** Epoch ms and the calendar's own time zone, so every answer starts from "Now". */
  now: number
  timeZone: string
  calendar: { id: string; name: string }
  from: string
  to: string
  events: CalendarEventSummary[]
  nextPageToken?: string
}

export type CalendarEventView = Omit<
  CalendarListView,
  'events' | 'from' | 'to' | 'nextPageToken'
> & {
  event: CalendarEventSummary & {
    description?: string
    organizer?: string
    htmlLink?: string
  }
}

export type CalendarsView = {
  account: string
  now: number
  timeZone: string
  calendars: { id: string; name: string; primary: boolean; access: string }[]
}

export type ContactSource = 'contacts' | 'other' | 'directory'

export type ContactsFindView = {
  account: string
  query: string
  people: { name: string; emails: string[]; source: ContactSource; title?: string }[]
  /** Sources Google wouldn't search, and why (a personal account has no directory). */
  skipped: { source: ContactSource; reason: string }[]
}
