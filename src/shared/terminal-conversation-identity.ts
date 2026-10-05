import { z } from 'zod'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from './agent-session-resume'
import { AGENT_MODEL_MAX_LENGTH, AGENT_TYPE_MAX_LENGTH } from './agent-status-field-normalization'
import type { AgentStatusEntry, AgentType } from './agent-status-types'

/** Provenance; never presence or liveness. Readers compare by equality and tolerate unknown values. */
export type TerminalConversationIdentitySource =
  | 'live'
  | 'retained'
  | 'legacy-row'
  | 'renderer'
  | (string & {})

/** The conversation a terminal pane's agent is in, as the execution host holds it. Not a status. */
export type TerminalConversationIdentity = {
  agentType: AgentType
  providerSession: AgentProviderSessionMetadata
  model?: string
  modelSwitchCommand?: 'orca-model'
  /** Host ms when this address, or its model, was last accepted. */
  capturedAt: number
  source: TerminalConversationIdentitySource
}

/** The identity fields every holder (store facet, wire field) shares. */
export type ConversationIdentityFields = Omit<TerminalConversationIdentity, 'source'>

export type TerminalConversationAddress = {
  agentType: AgentType | null
  providerSession: AgentProviderSessionMetadata
}

const conversationIdentityFieldsSchema = z.object({
  agentType: z
    .string()
    .min(1)
    .max(AGENT_TYPE_MAX_LENGTH)
    .refine((agentType) => agentType !== 'unknown'),
  providerSession: z.unknown(),
  model: z.string().min(1).max(AGENT_MODEL_MAX_LENGTH).optional(),
  modelSwitchCommand: z.literal('orca-model').optional(),
  capturedAt: z.number().finite().positive()
})

/** Parses the shared identity fields; null when any is missing or malformed. */
export function readConversationIdentityFields(raw: unknown): ConversationIdentityFields | null {
  const parsed = conversationIdentityFieldsSchema.safeParse(raw)
  const providerSession = parsed.success
    ? normalizeAgentProviderSession(parsed.data.providerSession)
    : null
  if (!parsed.success || !providerSession) {
    return null
  }
  const { agentType, model, modelSwitchCommand, capturedAt } = parsed.data
  return {
    agentType,
    providerSession,
    ...(model ? { model } : {}),
    ...(modelSwitchCommand ? { modelSwitchCommand } : {}),
    capturedAt
  }
}

const sourceSchema = z.object({ source: z.string() })

/** Absent and malformed both read as `undefined`; a malformed field is discarded for its tab only. */
export function readTerminalConversationIdentity(
  raw: unknown
): TerminalConversationIdentity | undefined {
  const fields = readConversationIdentityFields(raw)
  const provenance = sourceSchema.safeParse(raw)
  // Why: an unknown provenance value is kept as is; readers only compare it.
  return fields && provenance.success ? { ...fields, source: provenance.data.source } : undefined
}

/** Every locator member; unlike `agentProviderSessionsEqual`, never ignores the path. */
export function conversationProviderSessionsEqual(
  left: AgentProviderSessionMetadata | null | undefined,
  right: AgentProviderSessionMetadata | null | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.key === right.key &&
    left.id === right.id &&
    (left.transcriptPath ?? null) === (right.transcriptPath ?? null)
  )
}

export function terminalConversationIdentityEqual(
  left: TerminalConversationIdentity | undefined,
  right: TerminalConversationIdentity | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.agentType === right.agentType &&
    conversationProviderSessionsEqual(left.providerSession, right.providerSession) &&
    left.model === right.model &&
    left.modelSwitchCommand === right.modelSwitchCommand &&
    left.capturedAt === right.capturedAt &&
    left.source === right.source
  )
}

/** Stable key for "the same conversation" (agent + full locator). */
export function conversationAddressKey(address: TerminalConversationAddress | null): string | null {
  if (!address) {
    return null
  }
  const session = address.providerSession
  return JSON.stringify([
    address.agentType,
    session.key,
    session.id,
    session.transcriptPath ?? null
  ])
}

/** The field's report identity: `capturedAt` alone can repeat (same-millisecond reports, clock rollback). */
export function conversationReportKey(identity: ConversationIdentityFields): string {
  const session = identity.providerSession
  return JSON.stringify([
    identity.agentType,
    session.key,
    session.id,
    session.transcriptPath ?? null,
    identity.capturedAt,
    identity.model ?? null,
    identity.modelSwitchCommand ?? null
  ])
}

export type TerminalConversationTabFields = {
  agentStatus?: unknown
  conversationIdentity?: unknown
  conversationOfferedWithoutStatus?: unknown
}

/** The host offers this statusless tab's identity as agent evidence and as its transcript address. */
export function conversationIsOfferedWithoutStatus(tab: TerminalConversationTabFields): boolean {
  return (
    !tab.agentStatus &&
    tab.conversationOfferedWithoutStatus === true &&
    readTerminalConversationIdentity(tab.conversationIdentity) !== undefined
  )
}

/** The identity's agent, only where the host offers it as agent evidence (never beside a genuine status). */
export function offeredConversationAgent(tab: TerminalConversationTabFields): AgentType | null {
  return conversationIsOfferedWithoutStatus(tab)
    ? (readTerminalConversationIdentity(tab.conversationIdentity)?.agentType ?? null)
    : null
}

type ConversationStatusFields = Pick<
  AgentStatusEntry,
  'agentType' | 'providerSession' | 'model' | 'modelSwitchCommand'
>

export type TerminalConversationSelection = {
  /** Effective address authority, not wire presence: `none` reads exactly as an old host. */
  authority: 'address' | 'none'
  address: TerminalConversationAddress | null
  model: string | null
  modelSwitchCommand: 'orca-model' | null
  modelSource: 'status' | 'field' | null
  /** The usable field's observed report identity, independent of which evidence supplied the model. */
  fieldReportKey: string | null
}

function statusModelSelection(
  status: ConversationStatusFields | null | undefined
): Pick<TerminalConversationSelection, 'model' | 'modelSwitchCommand' | 'modelSource'> {
  return {
    model: status?.model ?? null,
    modelSwitchCommand: status?.modelSwitchCommand ?? null,
    modelSource: status?.model ? 'status' : null
  }
}

/** One reading of a pane's conversation for every client: field authority, else the legacy status read. */
export function selectTerminalConversation(args: {
  conversationIdentity?: unknown
  conversationOfferedWithoutStatus?: unknown
  agentStatus?: ConversationStatusFields | null
  agent: AgentType | null | undefined
}): TerminalConversationSelection {
  const status = args.agentStatus ?? null
  const identity = readTerminalConversationIdentity(args.conversationIdentity)
  const statusMatchesAgent = !!status && (status.agentType ?? args.agent) === args.agent
  const usable =
    identity !== undefined &&
    !!args.agent &&
    identity.agentType === args.agent &&
    (!!status || args.conversationOfferedWithoutStatus === true)
  if (!identity || !usable) {
    return {
      authority: 'none',
      address: status?.providerSession
        ? {
            agentType: status.agentType ?? args.agent ?? null,
            providerSession: status.providerSession
          }
        : null,
      ...statusModelSelection(status),
      fieldReportKey: null
    }
  }
  // Why: a genuine status for this conversation carries the store's latest admitted model,
  // including a model chosen without session metadata that never reaches the field.
  const statusSuppliesModel =
    statusMatchesAgent &&
    !!status?.model &&
    (!status.providerSession ||
      conversationProviderSessionsEqual(status.providerSession, identity.providerSession))
  return {
    authority: 'address',
    address: { agentType: identity.agentType, providerSession: identity.providerSession },
    ...(statusSuppliesModel
      ? statusModelSelection(status)
      : identity.model
        ? {
            model: identity.model,
            modelSwitchCommand: identity.modelSwitchCommand ?? null,
            modelSource: 'field' as const
          }
        : {
            model: null,
            modelSwitchCommand:
              identity.modelSwitchCommand ??
              (statusMatchesAgent ? (status?.modelSwitchCommand ?? null) : null),
            modelSource: null
          }),
    fieldReportKey: identity.model ? conversationReportKey(identity) : null
  }
}
