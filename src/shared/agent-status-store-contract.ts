import type {
  AgentChildWorkAliasInput,
  AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import type { AgentChildWorkInput, AgentChildWorkRecord } from './agent-status-child-work'
import type { AgentStatusParentInput, AgentStatusParentRecord } from './agent-status-store-parent'
import type { AgentStatusSubject } from './agent-status-subject'

export const AGENT_STATUS_STORE_SNAPSHOT_VERSION = 1 as const
export const AGENT_STATUS_STORE_LIMITS = {
  parents: 2_048,
  children: 8_192,
  aliases: 16_384,
  facts: 16_384,
  tombstones: 1_024,
  mutationEntries: 2_048,
  serializedBytes: 16 * 1024 * 1024
} as const

export const AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS = 4_096

export type AgentStatusFactValue = string | number | boolean | null

export type AgentStatusFactInput = {
  subject: AgentStatusSubject
  key: string
  value: AgentStatusFactValue
}

export type AgentStatusFactRecord = AgentStatusFactInput & { revision: number }
export type AgentStatusFactIdentity = Pick<AgentStatusFactInput, 'subject' | 'key'>
export type AgentStatusTombstoneEntity = 'parent' | 'child' | 'alias' | 'fact'

export type AgentStatusTombstoneInput = {
  entity: AgentStatusTombstoneEntity
  key: string
}

export type AgentStatusTombstoneRecord = AgentStatusTombstoneInput & { revision: number }

export type AgentStatusStoreMutation = {
  parent?: AgentStatusParentInput
  removeParent?: AgentStatusSubject
  children?: AgentChildWorkInput[]
  removeChildren?: string[]
  aliases?: AgentChildWorkAliasInput[]
  removeAliases?: string[]
  facts?: AgentStatusFactInput[]
  removeFacts?: AgentStatusFactIdentity[]
  tombstones?: AgentStatusTombstoneInput[]
}

export type AgentStatusStoreSnapshot = {
  version: typeof AGENT_STATUS_STORE_SNAPSHOT_VERSION
  epoch: string
  revision: number
  parents: AgentStatusParentRecord[]
  children: AgentChildWorkRecord[]
  aliases: AgentChildWorkAliasRecord[]
  facts: AgentStatusFactRecord[]
  tombstones: AgentStatusTombstoneRecord[]
}
