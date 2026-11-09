// Main ↔ window events and the orcad RPC the Orca Cloud lease scheduler uses.
import { z } from 'zod'

/** orcad: is real work running (agents, chats, automations), and when did a person last type in a PTY. */
export const ORCAD_WORK_VERDICT_METHOD = 'orcad.workVerdict'
export const OrcadWorkVerdictParamsSchema = z.object({}).strict()

export type OrcadWorkVerdict = {
  verdict: 'idle' | 'busy' | 'unverifiable'
  /** Epoch ms since every work probe has read idle, as seen by this orcad. */
  idleSince: number | null
  /** Epoch ms of the latest driving (user) input to any terminal. */
  lastPtyInputAt: number | null
}

export type HostedSessionWarningEvent = {
  workspaceId: string | null
  workspaceName: string | null
  minutesLeft: 60 | 15
}

export type HostedSessionIdleSleepEvent = {
  workspaceId: string | null
  /** How long the workspace was idle before sleeping (for "slept after N min idle"); optional for older mains. */
  idleMs?: number | null
}
