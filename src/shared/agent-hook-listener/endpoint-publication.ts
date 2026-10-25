import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { sweepStaleAgentHookEndpointTemps } from '../agent-hook-endpoint-temp-cleanup'

export function getEndpointFileName(): string {
  // Use native sourceable extensions: POSIX .env / Windows .cmd; OpenCode accepts both.
  return process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'
}

export function isShellSafeEndpointValue(value: string): boolean {
  // Shell-sourced values must be safe and nonempty or KEY= would clear inherited state.
  return /^[A-Za-z0-9._:/-]+$/.test(value)
}

export type EndpointFileFields = {
  port: number
  token: string
  env: string
  version: string
  transport?: string
  openCodeTui?: boolean
}

/** Atomically publish; false lets callers fall back to PTY env. Keep aligned with AgentHookServer.writeEndpointFile. */
export function writeEndpointFile(
  endpointDir: string,
  finalPath: string,
  fields: EndpointFileFields
): boolean {
  const tmpPath = join(endpointDir, `.endpoint-${process.pid}-${randomUUID()}.tmp`)
  const prefix = process.platform === 'win32' ? 'set ' : ''
  const valuesToWrite: [string, string][] = [
    ['ORCA_AGENT_HOOK_PORT', String(fields.port)],
    ['ORCA_AGENT_HOOK_TOKEN', fields.token],
    ['ORCA_AGENT_HOOK_ENV', fields.env],
    ['ORCA_AGENT_HOOK_VERSION', fields.version]
  ]
  if (fields.transport) {
    valuesToWrite.push(['ORCA_AGENT_HOOK_TRANSPORT', fields.transport])
  }
  if (fields.openCodeTui) {
    valuesToWrite.push(['ORCA_AGENT_HOOK_OPENCODE_TUI', '1'])
  }
  for (const [key, value] of valuesToWrite) {
    if (!isShellSafeEndpointValue(value)) {
      console.error(
        `[agent-hooks] refusing to write endpoint file: ${key} contains ` +
          'characters unsafe for shell sourcing. Falling back to PTY env.'
      )
      return false
    }
  }
  const lines = [...valuesToWrite.map(([key, value]) => `${prefix}${key}=${value}`), '']
  let tmpWritten = false
  try {
    // Keep the endpoint directory owner-only to hide this install from other local users.
    mkdirSync(endpointDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // Creation mode does not repair existing directories; chmod them on POSIX.
      try {
        chmodSync(endpointDir, 0o700)
      } catch {
        // best-effort
      }
    }
    // Bound crash-orphan sweeps even in tampered directories.
    sweepStaleAgentHookEndpointTemps(endpointDir)
    const separator = process.platform === 'win32' ? '\r\n' : '\n'
    writeFileSync(tmpPath, lines.join(separator), { mode: 0o600 })
    tmpWritten = true
    renameSync(tmpPath, finalPath)
    return true
  } catch (err) {
    console.error('[agent-hooks] failed to write endpoint file:', err)
    if (tmpWritten) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp may already be gone
      }
    }
    return false
  }
}

const REUSABLE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Port and token a previous run published, when the file is still this user's and owner-only. */
export function readPublishedEndpoint(finalPath: string): { port: number; token: string } | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stat = statSync(finalPath)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      return null
    }
    const values = new Map<string, string>()
    for (const line of readFileSync(finalPath, 'utf8').split('\n')) {
      const separator = line.indexOf('=')
      if (separator > 0) {
        values.set(line.slice(0, separator), line.slice(separator + 1).trim())
      }
    }
    const port = Number(values.get('ORCA_AGENT_HOOK_PORT'))
    const token = values.get('ORCA_AGENT_HOOK_TOKEN') ?? ''
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !REUSABLE_TOKEN_PATTERN.test(token)
    ) {
      return null
    }
    return { port, token }
  } catch {
    return null
  }
}
