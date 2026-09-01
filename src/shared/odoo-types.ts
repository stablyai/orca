// Orca targets Odoo Community, where ticketing lives in the Project app:
// a ticket is a `project.task` on a `project.project`, moving through
// `project.task.type` stages. Enterprise-only `helpdesk.ticket` is not modeled.

/** Odoo `project.task.priority` selection values, lowest to highest. */
export const ODOO_PRIORITIES = ['0', '1', '2', '3'] as const

export type OdooPriority = (typeof ODOO_PRIORITIES)[number]

/**
 * Odoo `project.task.state` selection values. `1_done` and `1_canceled` are
 * Odoo's CLOSED_STATES; every other value counts as open.
 */
export const ODOO_TICKET_STATES = [
  '01_in_progress',
  '02_changes_requested',
  '03_approved',
  '04_waiting_normal',
  '1_done',
  '1_canceled'
] as const

export type OdooTicketState = (typeof ODOO_TICKET_STATES)[number]

export const ODOO_CLOSED_STATES: readonly OdooTicketState[] = ['1_done', '1_canceled']

export type OdooInstance = {
  id: string
  serverUrl: string
  /** Odoo is multi-tenant per server, so the database is part of the identity. */
  database: string
  login: string
  /** Resolved at connect; every execute_kw call must pass it. */
  uid: number
  displayName: string
}

export type OdooViewer = {
  uid: number
  displayName: string
  login: string
  avatarUrl?: string
}

/** A saved instance id, or the literal `all` for the cross-instance view. */
export type OdooInstanceSelection = string

export type OdooConnectionStatus = {
  connected: boolean
  viewer: OdooViewer | null
  instances?: OdooInstance[]
  activeInstanceId?: string | null
  selectedInstanceId?: OdooInstanceSelection | null
  // Set when a stored key file exists but could not be decrypted, so the UI can
  // explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type OdooProject = {
  id: number
  name: string
  instanceId?: string
  instanceName?: string
}

export type OdooStage = {
  id: number
  name: string
  sequence: number
  /** Folded stages are Odoo's collapsed/closed kanban columns. */
  fold: boolean
  /** Odoo kanban color index (0-11); drives the stage badge tint. */
  color?: number
}

export type OdooUser = {
  id: number
  displayName: string
  login?: string
  /** Data URI built from Odoo's `avatar_128`; absent when the record has none. */
  avatarUrl?: string
}

/** A ticket's `partner_id` (Customer); Odoo shows it in the chatter header. */
export type OdooPartner = {
  id: number
  name: string
}

export type OdooTag = {
  id: number
  name: string
  color?: number
}

export type OdooTicket = {
  id: number
  /** Human-facing identifier Orca shows in lists, e.g. `#4`. */
  ref: string
  instanceId?: string
  instanceName?: string
  title: string
  description?: string
  url: string
  /** Absent for private todos (`project_todo`), which carry no project. */
  project?: OdooProject
  /** `partner_id`: the ticket's Customer, when set. */
  customer?: OdooPartner
  stage?: OdooStage
  state: OdooTicketState
  priority: OdooPriority
  tags: OdooTag[]
  /** `project.task.user_ids` is many2many: a ticket can have several assignees. */
  assignees: OdooUser[]
  creator?: OdooUser
  deadline?: string
  createdAt: string
  updatedAt: string
}

export type OdooCommentAttachment = {
  id: number
  name: string
  mimetype?: string
  /** Absolute /web/content URL on the ticket's instance. */
  url: string
}

export type OdooComment = {
  id: number
  /** Odoo chatter stores HTML; the client converts it to markdown. */
  body: string
  createdAt: string
  author?: OdooUser
  /** True when the message's subtype is internal (Odoo "Log note"). */
  isNote: boolean
  attachments?: OdooCommentAttachment[]
  /** True when the session user authored it and may still edit the body. */
  canEdit?: boolean
}

export type OdooMentionSuggestion = {
  /** res.partner id — what message_post's partner_ids expects. */
  id: number
  name: string
  login?: string
  avatarUrl?: string
}

export type OdooAttachmentUpload = {
  name: string
  mimetype: string
  /** Base64 payload without the `data:` prefix. */
  data: string
}

export type OdooTicketUpdate = {
  title?: string
  description?: string
  stageId?: number
  priority?: OdooPriority
  state?: OdooTicketState
  assigneeIds?: number[]
  tagIds?: number[]
  deadline?: string | null
}

export type OdooTicketFilter = 'assigned' | 'reported' | 'all' | 'done'

export type OdooConnectArgs = {
  serverUrl: string
  database: string
  login: string
  apiKey: string
}

export type OdooCreateTicketArgs = {
  instanceId?: string
  projectId: number
  title: string
  description?: string
  priority?: OdooPriority
  stageId?: number
  assigneeIds?: number[]
}

export type OdooCreateTicketResult =
  | { ok: true; id: number; ref: string; url: string }
  | { ok: false; error: string }

export type OdooMutationResult = { ok: true } | { ok: false; error: string }
