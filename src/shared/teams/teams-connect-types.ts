// What a Microsoft Teams sign-in kept on this host shows its clients: who signed in, through which
// Entra app, and what Teams allowed. Tokens never leave the host.
import type { HostAccountSignInPhase } from '../agent-accounts/host-account-sign-in-types'

/** A host that checks teams.mentioned rules itself, or a client that reads them without crashing. */
export const TEAMS_TRIGGERS_RUNTIME_CAPABILITY = 'teams.triggers.v1' as const

/** The code the person types at Microsoft's device sign-in page, on any device. */
export type TeamsSignInPrompt = {
  verificationUri: string
  userCode: string
  expiresAt: number
}

export type TeamsAccountView = {
  name: string
  email: string | null
  tenantId: string
  clientId: string
  status: 'connected' | 'reconnect'
  reason?: string
  /** Whether channels (teams, their channels and posts) were asked for, or only chats. */
  channels: boolean
  grantedScopes: string[]
  connectedAt: number
}

export type TeamsSignInStatus = {
  flowId: string
  revision: number
  phase: HostAccountSignInPhase
  prompt?: TeamsSignInPrompt
  error?: string
  account?: TeamsAccountView
}

export type TeamsStatusView = {
  account: TeamsAccountView | null
  /** The bots the owner turned Teams on for; empty for a bot asking, which sees only `you`. */
  bots: { id: string; name: string }[]
  /** For a bot asking: whether its owner turned Teams on for it. */
  you?: { name: string; on: boolean }
}

export type TeamsPlaceView = { ref: string; label: string; kind: 'chat' | 'channel' | 'thread' }

export type TeamsMessageView = {
  ref: string
  from: string
  at: string
  text: string
}

export type TeamsFindView = { matches: TeamsPlaceView[]; note?: string }

export type TeamsReadView = {
  place: TeamsPlaceView
  messages: TeamsMessageView[]
  /** More messages exist past what was read (older ones in a chat or thread). */
  more: boolean
}

export type TeamsPostView = { ref: string; webUrl?: string }
