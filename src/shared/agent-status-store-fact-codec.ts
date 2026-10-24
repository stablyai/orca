import type {
  AgentStatusFactIdentity,
  AgentStatusFactInput,
  AgentStatusFactRecord,
  AgentStatusFactValue
} from './agent-status-store-contract'
import { isBoundedString } from './agent-status-child-work-value-guards'
import {
  deserializeAgentStatusSubject,
  parseAgentStatusSubject,
  serializeAgentStatusSubject
} from './agent-status-subject'

const MAX_FACT_KEY_LENGTH = 256
const MAX_FACT_STRING_LENGTH = 4_096
const FACT_KEY_PREFIX = 'agent-status-fact-v1:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseFactValue(value: unknown): AgentStatusFactValue | undefined {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.length <= MAX_FACT_STRING_LENGTH ? value : undefined
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseAgentStatusFactInput(value: unknown): AgentStatusFactInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ['subject', 'key', 'value'])) {
    return null
  }
  const subject = parseAgentStatusSubject(value.subject)
  const factValue = parseFactValue(value.value)
  if (!subject || !isBoundedString(value.key, MAX_FACT_KEY_LENGTH) || factValue === undefined) {
    return null
  }
  return { subject, key: value.key, value: factValue }
}

export function parseAgentStatusFactRecord(value: unknown): AgentStatusFactRecord | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null
  }
  const input = { ...value }
  delete input.revision
  const fact = parseAgentStatusFactInput(input)
  return fact ? { ...fact, revision: value.revision } : null
}

export function parseAgentStatusFactIdentity(value: unknown): AgentStatusFactIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['subject', 'key'])) {
    return null
  }
  const subject = parseAgentStatusSubject(value.subject)
  return subject && isBoundedString(value.key, MAX_FACT_KEY_LENGTH)
    ? { subject, key: value.key }
    : null
}

export function serializeAgentStatusFactKey(fact: AgentStatusFactIdentity): string {
  const parsed = parseAgentStatusFactIdentity({ subject: fact.subject, key: fact.key })
  if (!parsed) {
    throw new Error('Invalid agent status fact identity')
  }
  return `${FACT_KEY_PREFIX}${JSON.stringify([
    serializeAgentStatusSubject(parsed.subject),
    parsed.key
  ])}`
}

export function deserializeAgentStatusFactKey(value: string): AgentStatusFactIdentity | null {
  if (!value.startsWith(FACT_KEY_PREFIX)) {
    return null
  }
  let tuple: unknown
  try {
    tuple = JSON.parse(value.slice(FACT_KEY_PREFIX.length))
  } catch {
    return null
  }
  if (!Array.isArray(tuple) || tuple.length !== 2) {
    return null
  }
  const [subjectKey, key] = tuple
  if (typeof subjectKey !== 'string') {
    return null
  }
  const subject = deserializeAgentStatusSubject(subjectKey)
  const parsed = parseAgentStatusFactIdentity({ subject, key })
  return parsed && serializeAgentStatusFactKey(parsed) === value ? parsed : null
}
