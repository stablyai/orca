// Opens the read snapshot a sleeping Orca Cloud workspace left behind: what its chats, agents, git
// and PR looked like when it went to sleep, so any authorized device can read it without waking the
// VM. The VM seals it (image/vm/orca-read-snapshot.js in the sandbox control plane) to every reader
// key allowed to open the workspace; the control plane stores and relays only ciphertext.
//
// Exact construction (keep in sync with the VM sealer):
//   dek    = 32 random bytes; body = AES-256-GCM(dek, nonce(12), utf8 JSON payload,
//            AAD = utf8 "orca-cloud-read-v1:" + workspaceId + ":" + snapshotId)
//   per reader key (fresh ephemeral X25519 each):
//     shared = X25519(ephemeralSecret, readerPublic)          (all-zero result is rejected)
//     kek    = HKDF-SHA256(ikm = shared, salt = ephemeralPublic(32) || readerPublic(32),
//                          info = utf8 "orca-cloud-read-wrap-v1", length = 32)
//     wrapped = AES-256-GCM(kek, nonce(12), dek,
//                AAD = utf8 "orca-cloud-read-wrap-v1:" + workspaceId + ":" + snapshotId + ":" + keyId)
//   ciphertexts are ct || tag(16).
// Free of node:crypto and Buffer so mobile (Hermes) can use it with the same primitives as grants.
import {
  base64ToBytes,
  type SealedGrantPrimitives
} from './sealed-grant'

export const READ_SNAPSHOT_INFO = 'orca-cloud-read-v1'
export const READ_SNAPSHOT_WRAP_INFO = 'orca-cloud-read-wrap-v1'

/** Plaintext bounds the VM keeps to (the opener re-checks them; anything over is cut, not trusted). */
export const READ_SNAPSHOT_LIMITS = {
  sessions: 12,
  messagesPerSession: 60,
  messageChars: 4000,
  changes: 200,
  commits: 10,
  titleChars: 200
} as const

export type ReadSnapshotRole = 'user' | 'assistant' | 'system'
export type ReadSnapshotMessage = { itemId: string; role: ReadSnapshotRole; text: string; at: number }
/** `attention`: waiting on a person (approval, question). `idle` + turnOutcome is "done". */
export type ReadSnapshotAgentStatus = 'working' | 'attention' | 'idle' | 'unknown'
export type ReadSnapshotSession = {
  sessionId: string
  /** Agent kind as orcad names it (claude, codex, …); free text, display only. */
  agent: string | null
  title: string | null
  status: ReadSnapshotAgentStatus
  turnOutcome: string | null
  updatedAt: number | null
  /** Oldest first; only the tail of a long chat. */
  messages: ReadSnapshotMessage[]
  /** Older messages exist that are not in this snapshot. */
  truncated: boolean
}
export type ReadSnapshotChange = {
  path: string
  status: string
  area: string
  added: number | null
  removed: number | null
}
export type ReadSnapshotGit = {
  branch: string | null
  head: string | null
  changes: ReadSnapshotChange[]
  changeCount: number
  added: number | null
  removed: number | null
  commits: { id: string; subject: string; author: string | null; at: number | null }[]
}
export type ReadSnapshotPr = {
  number: number
  title: string
  state: string
  url: string
  checksStatus: string | null
  checksSummary: string | null
}
export type ReadSnapshot = {
  v: 1
  workspaceId: string
  snapshotId: string
  /** When the VM captured it (ms). "As of" on every surface. */
  capturedAt: number
  reason: string
  git: ReadSnapshotGit | null
  pr: ReadSnapshotPr | null
  sessions: ReadSnapshotSession[]
}

/** What the control plane hands one device: the body plus only that device's wrapped key. */
export type SealedReadSnapshot = {
  v: 1
  snapshotId: string
  workspaceId: string
  /** When the control plane stored it (ms); the payload's own capturedAt is the one to show. */
  storedAt: number
  nonceB64: string
  ciphertextB64: string
  recipient: {
    keyId: string
    ephemeralPublicKeyB64: string
    nonceB64: string
    wrappedKeyB64: string
  }
}

export class ReadSnapshotError extends Error {
  constructor(readonly code: 'malformed' | 'decrypt_failed' | 'invalid_payload' | 'wrong_workspace') {
    super(code)
    this.name = 'ReadSnapshotError'
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function decodeB64(value: string): Uint8Array {
  try {
    return base64ToBytes(value)
  } catch {
    throw new ReadSnapshotError('malformed')
  }
}

export async function openReadSnapshot(
  sealed: SealedReadSnapshot,
  /** The workspace the caller asked for; a snapshot of any other workspace is refused. */
  workspaceId: string,
  readerSecretKey: Uint8Array,
  primitives: SealedGrantPrimitives
): Promise<ReadSnapshot> {
  if (sealed.v !== 1 || readerSecretKey.length !== 32) {
    throw new ReadSnapshotError('malformed')
  }
  if (sealed.workspaceId !== workspaceId) {
    throw new ReadSnapshotError('wrong_workspace')
  }
  const { recipient } = sealed
  const ephemeral = decodeB64(recipient.ephemeralPublicKeyB64)
  const wrapNonce = decodeB64(recipient.nonceB64)
  const wrapped = decodeB64(recipient.wrappedKeyB64)
  const nonce = decodeB64(sealed.nonceB64)
  const ciphertext = decodeB64(sealed.ciphertextB64)
  if (
    ephemeral.length !== 32 ||
    wrapNonce.length !== 12 ||
    wrapped.length !== 48 ||
    nonce.length !== 12 ||
    ciphertext.length < 17
  ) {
    throw new ReadSnapshotError('malformed')
  }
  const encoder = new TextEncoder()
  let readerPublic: Uint8Array
  let shared: Uint8Array
  try {
    readerPublic = await primitives.x25519PublicKey(readerSecretKey)
    shared = await primitives.x25519(readerSecretKey, ephemeral)
  } catch {
    throw new ReadSnapshotError('decrypt_failed')
  }
  // A low-order ephemeral key yields an all-zero secret anyone can compute.
  if (shared.every((byte) => byte === 0)) {
    throw new ReadSnapshotError('decrypt_failed')
  }
  const kek = await primitives.hkdfSha256(
    shared,
    concat(ephemeral, readerPublic),
    encoder.encode(READ_SNAPSHOT_WRAP_INFO),
    32
  )
  const scope = `${workspaceId}:${sealed.snapshotId}`
  let plaintext: Uint8Array
  try {
    const dek = await primitives.aesGcmDecrypt(
      kek,
      wrapNonce,
      wrapped,
      encoder.encode(`${READ_SNAPSHOT_WRAP_INFO}:${scope}:${recipient.keyId}`)
    )
    plaintext = await primitives.aesGcmDecrypt(
      dek,
      nonce,
      ciphertext,
      encoder.encode(`${READ_SNAPSHOT_INFO}:${scope}`)
    )
    dek.fill(0)
  } catch {
    throw new ReadSnapshotError('decrypt_failed')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new ReadSnapshotError('invalid_payload')
  }
  const snapshot = parseReadSnapshot(parsed)
  // The AAD already binds these; a mismatch means the VM itself wrote something odd.
  if (!snapshot || snapshot.workspaceId !== workspaceId || snapshot.snapshotId !== sealed.snapshotId) {
    throw new ReadSnapshotError('invalid_payload')
  }
  return snapshot
}

// The payload came from the VM: parse leniently field by field, cut to the limits, never trust it.
type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system'])
const STATUSES: ReadonlySet<string> = new Set(['working', 'attention', 'idle'])

function messageOf(value: unknown): ReadSnapshotMessage | null {
  if (!isObj(value) || typeof value.role !== 'string' || !ROLES.has(value.role)) {
    return null
  }
  const text = str(value.text, READ_SNAPSHOT_LIMITS.messageChars)
  const itemId = str(value.itemId, 200)
  if (!text || !itemId) {
    return null
  }
  return { itemId, role: value.role as ReadSnapshotRole, text, at: num(value.at) ?? 0 }
}

function sessionOf(value: unknown): ReadSnapshotSession | null {
  if (!isObj(value)) {
    return null
  }
  const sessionId = str(value.sessionId, 200)
  if (!sessionId) {
    return null
  }
  const all = arr(value.messages)
    .map(messageOf)
    .filter((m): m is ReadSnapshotMessage => m !== null)
  const messages = all.slice(-READ_SNAPSHOT_LIMITS.messagesPerSession)
  const status = typeof value.status === 'string' && STATUSES.has(value.status) ? value.status : 'unknown'
  return {
    sessionId,
    agent: str(value.agent, 40),
    title: str(value.title, READ_SNAPSHOT_LIMITS.titleChars),
    status: status as ReadSnapshotAgentStatus,
    turnOutcome: str(value.turnOutcome, 40),
    updatedAt: num(value.updatedAt),
    messages,
    truncated: value.truncated === true || messages.length < all.length
  }
}

function gitOf(value: unknown): ReadSnapshotGit | null {
  if (!isObj(value)) {
    return null
  }
  const changes = arr(value.changes)
    .flatMap((raw): ReadSnapshotChange[] => {
      if (!isObj(raw)) {
        return []
      }
      const path = str(raw.path, 1024)
      return path
        ? [
            {
              path,
              status: str(raw.status, 20) ?? 'modified',
              area: str(raw.area, 20) ?? 'unstaged',
              added: num(raw.added),
              removed: num(raw.removed)
            }
          ]
        : []
    })
    .slice(0, READ_SNAPSHOT_LIMITS.changes)
  const commits = arr(value.commits)
    .flatMap((raw) => {
      if (!isObj(raw)) {
        return []
      }
      const id = str(raw.id, 64)
      const subject = str(raw.subject, 300)
      return id && subject !== null
        ? [{ id, subject, author: str(raw.author, 120), at: num(raw.at) }]
        : []
    })
    .slice(0, READ_SNAPSHOT_LIMITS.commits)
  return {
    branch: str(value.branch, 255),
    head: str(value.head, 64),
    changes,
    changeCount: Math.max(num(value.changeCount) ?? changes.length, changes.length),
    added: num(value.added),
    removed: num(value.removed),
    commits
  }
}

function prOf(value: unknown): ReadSnapshotPr | null {
  if (!isObj(value)) {
    return null
  }
  const number = num(value.number)
  const url = str(value.url, 500)
  // Only links a person can safely tap.
  if (number === null || !url || !url.startsWith('https://')) {
    return null
  }
  return {
    number,
    title: str(value.title, 300) ?? '',
    state: str(value.state, 20) ?? 'open',
    url,
    checksStatus: str(value.checksStatus, 20),
    checksSummary: str(value.checksSummary, 200)
  }
}

export function parseReadSnapshot(value: unknown): ReadSnapshot | null {
  if (!isObj(value) || value.v !== 1) {
    return null
  }
  const workspaceId = str(value.workspaceId, 64)
  const snapshotId = str(value.snapshotId, 64)
  const capturedAt = num(value.capturedAt)
  if (!workspaceId || !snapshotId || capturedAt === null) {
    return null
  }
  return {
    v: 1,
    workspaceId,
    snapshotId,
    capturedAt,
    reason: str(value.reason, 20) ?? 'sleep',
    git: gitOf(value.git),
    pr: prOf(value.pr),
    sessions: arr(value.sessions)
      .map(sessionOf)
      .filter((s): s is ReadSnapshotSession => s !== null)
      .slice(0, READ_SNAPSHOT_LIMITS.sessions)
  }
}
