// Owner manifest published by a detached POSIX relay next to the Unix socket it owns.
//
// It exists so a client whose reconnect failed can prove *which process* owns the socket before
// signalling anything. The generation token is minted per launch and also appears in the relay's
// argv, so a recycled PID cannot reproduce it. The token is not itself a process-start identity:
// that comes from a separate OS value the reaper reads and re-compares (see
// ssh-relay-generation-owner-commands.ts). Everything here is format-only so both the relay and the
// client parse identically.

export const RELAY_OWNER_MANIFEST_HEADER = 'orca-relay-owner-1'
// Why: the client reads this file over SSH with `head -c`; a fixed bound keeps a tampered or
// truncated file from becoming an unbounded remote read.
export const RELAY_OWNER_MANIFEST_MAX_BYTES = 4096
export const RELAY_OWNER_MANIFEST_SUFFIX = '.owner'

const GENERATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
// Why: device, inode and change time together — inode numbers are recycled aggressively on ext4, so
// inode alone would let a stale manifest claim a successor's socket at the same path.
const SOCKET_IDENTITY_PATTERN = /^[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}$/
const MAX_PID = 2 ** 31 - 1
const MANIFEST_KEYS = ['generation', 'pid', 'sock', 'dev', 'ino', 'ctime'] as const

export type RelayOwnerManifest = {
  generation: string
  pid: number
  socketPath: string
  socketDev: number
  socketIno: number
  /** Inode change time in whole seconds — the granularity every supported `stat` reports. */
  socketCtimeSeconds: number
}

/** `dev:ino:ctime`, the exact string a remote `stat` emits for the socket. */
export function relaySocketIdentity(manifest: RelayOwnerManifest): string {
  return `${manifest.socketDev}:${manifest.socketIno}:${manifest.socketCtimeSeconds}`
}

export function isRelaySocketIdentity(value: string): boolean {
  return SOCKET_IDENTITY_PATTERN.test(value)
}

export function isRelayGenerationToken(token: string): boolean {
  return GENERATION_TOKEN_PATTERN.test(token)
}

export function relayOwnerManifestPath(sockPath: string): string {
  return `${sockPath}${RELAY_OWNER_MANIFEST_SUFFIX}`
}

// Why: shape, not `process.platform` — a client on macOS reasons about a Windows host's endpoint,
// and a named pipe never has an adjacent manifest to publish or verify.
export function isRelayNamedPipeEndpoint(sockPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

export function serializeRelayOwnerManifest(manifest: RelayOwnerManifest): string {
  if (!isRelayGenerationToken(manifest.generation)) {
    throw new Error('Relay owner manifest generation token must be 64 lowercase hex characters')
  }
  if (!isStrictPositiveInteger(manifest.pid)) {
    throw new Error(`Relay owner manifest pid is out of range: ${manifest.pid}`)
  }
  if (/[\r\n]/.test(manifest.socketPath)) {
    throw new Error('Relay owner manifest socket path must not contain a newline')
  }
  if (!isRelaySocketIdentity(relaySocketIdentity(manifest))) {
    throw new Error('Relay owner manifest socket identity must be three unsigned integers')
  }
  return [
    RELAY_OWNER_MANIFEST_HEADER,
    `generation=${manifest.generation}`,
    `pid=${manifest.pid}`,
    `sock=${manifest.socketPath}`,
    `dev=${manifest.socketDev}`,
    `ino=${manifest.socketIno}`,
    `ctime=${manifest.socketCtimeSeconds}`,
    ''
  ].join('\n')
}

export function parseRelayOwnerManifest(text: string): RelayOwnerManifest | null {
  if (Buffer.byteLength(text, 'utf8') > RELAY_OWNER_MANIFEST_MAX_BYTES) {
    return null
  }
  const lines = text.split(/\r?\n/)
  // Why: a remote `head -c` read can append or preserve trailing newlines; only leading structure matters.
  while (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.shift() !== RELAY_OWNER_MANIFEST_HEADER) {
    return null
  }
  const fields = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      return null
    }
    const key = line.slice(0, separator)
    if (!isManifestKey(key) || fields.has(key)) {
      return null
    }
    fields.set(key, line.slice(separator + 1))
  }
  if (fields.size !== MANIFEST_KEYS.length) {
    return null
  }
  const generation = fields.get('generation') as string
  const socketPath = fields.get('sock') as string
  const pid = parseUnsignedField(fields.get('pid') as string)
  const socketDev = parseUnsignedField(fields.get('dev') as string)
  const socketIno = parseUnsignedField(fields.get('ino') as string)
  const socketCtimeSeconds = parseUnsignedField(fields.get('ctime') as string)
  if (!isRelayGenerationToken(generation) || !socketPath.startsWith('/')) {
    return null
  }
  if (pid === null || !isStrictPositiveInteger(pid)) {
    return null
  }
  if (socketDev === null || socketIno === null || socketCtimeSeconds === null) {
    return null
  }
  return { generation, pid, socketPath, socketDev, socketIno, socketCtimeSeconds }
}

function isManifestKey(key: string): key is (typeof MANIFEST_KEYS)[number] {
  return (MANIFEST_KEYS as readonly string[]).includes(key)
}

function isStrictPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PID
}

function parseUnsignedField(raw: string): number | null {
  if (!/^[0-9]{1,20}$/.test(raw)) {
    return null
  }
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}
