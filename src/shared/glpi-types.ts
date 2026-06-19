// GLPI task-source integration types. GLPI is an account-based ITSM source
// (tickets are not tied to a git repo), so it mirrors the Jira multi-account
// credential model (jira-types.ts). Auth uses the classic GLPI REST API
// (/apirest.php): an application token (App-Token) plus a per-user API token,
// exchanged for a short-lived Session-Token via initSession.

export type GlpiServer = {
  id: string
  // Web base URL shown in the UI, e.g. https://glpi.example.com
  baseUrl: string
  // REST API base, e.g. https://glpi.example.com/apirest.php
  apiBaseUrl: string
  displayName: string
  account: string | null
}

export type GlpiViewer = {
  id: number
  login: string
  fullName: string | null
}

// A specific stored server id, or 'all' to fan a read across every server.
export type GlpiServerSelection = string | 'all'

export type GlpiConnectionStatus = {
  connected: boolean
  viewer: GlpiViewer | null
  servers?: GlpiServer[]
  activeServerId?: string | null
  selectedServerId?: GlpiServerSelection | null
  // Set when a stored token file exists but could not be decrypted, so the UI
  // can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type GlpiConnectArgs = {
  baseUrl: string
  appToken: string
  userToken: string
}

export type GlpiUser = {
  id: number
  login: string
  fullName?: string
}

// GLPI ticket lifecycle. Numeric codes (1..6) are mapped to these keys at the
// API boundary so the renderer never deals with raw GLPI integers.
export type GlpiTicketStatus = 'new' | 'assigned' | 'planned' | 'pending' | 'solved' | 'closed'

// GLPI tickets are either an incident (type 1) or a service request (type 2).
export type GlpiTicketType = 'incident' | 'request'

export type GlpiTicket = {
  id: number
  serverId?: string
  serverName?: string
  title: string
  // Raw HTML body as returned by GLPI; the renderer sanitizes before display.
  content?: string
  status: GlpiTicketStatus
  // Urgency and priority are GLPI 1 (very low) .. 5 (very high) scales.
  urgency: number
  priority: number
  type: GlpiTicketType
  category?: string
  requester?: GlpiUser
  assignees: GlpiUser[]
  url: string
  followups: number
  updatedAt: string
  createdAt: string
}

export type GlpiFollowup = {
  id: number
  content: string
  isPrivate: boolean
  createdAt: string
  user?: GlpiUser
}

export type GlpiTicketFilter = 'assigned' | 'created' | 'all' | 'closed'

// Server-side narrowing applied on top of the GlpiTicketFilter scope. Each set
// field appends an AND-linked search criterion against the GLPI Ticket schema.
export type GlpiWorkItemFilters = {
  type?: GlpiTicketType // 'incident' | 'request'
  text?: string // free-text in ticket title
  category?: string // category name contains
  priority?: number // GLPI 1..5
}

export type GlpiTicketUpdate = {
  title?: string
  content?: string
  status?: GlpiTicketStatus
}

export type GlpiCreateTicketArgs = {
  serverId?: string
  title: string
  content?: string
  type?: GlpiTicketType
  urgency?: number
}

export type GlpiCreateTicketResult =
  | { ok: true; id: number; url: string }
  | { ok: false; error: string }

export type GlpiMutationResult = { ok: true } | { ok: false; error: string }
