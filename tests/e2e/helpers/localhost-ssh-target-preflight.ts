import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLocalhostSshTarget, type LocalhostSshTarget } from './localhost-ssh-target'

// Why: the Electron app runs under an isolated HOME (electron-home-isolation.ts), so its ssh2
// client never sees the developer's ~/.ssh keys and falls back to keyboard-interactive (which
// connectSshTestTarget cancels). CI sets ORCA_E2E_SSH_IDENTITY_FILE explicitly; locally, pick the
// first default OpenSSH identity from the runner's real home so the app authenticates like `ssh`.
function resolveDefaultIdentityFile(): string | undefined {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const candidate = path.join(os.homedir(), '.ssh', name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

function readPreflightSshTarget(): LocalhostSshTarget {
  const target = readLocalhostSshTarget(`Mirror echo SSH E2E ${Date.now()}`)
  if (target.configHost || target.identityFile) {
    return target
  }
  const identityFile = resolveDefaultIdentityFile()
  return identityFile ? { ...target, identityFile } : target
}

type SshPreflight = { ok: true; target: LocalhostSshTarget } | { ok: false; reason: string }

/** Skips loudly instead of failing: sshd/key state and the relay bundle both drift over time. */
export function sshLocalhostPreflight(): SshPreflight {
  if (process.env.ORCA_E2E_SSH_LOCALHOST !== '1') {
    return { ok: false, reason: 'Set ORCA_E2E_SSH_LOCALHOST=1 to run the localhost SSH test.' }
  }
  if (process.platform === 'win32') {
    return { ok: false, reason: 'Localhost SSH test uses a POSIX sshd.' }
  }
  const relayBundle = path.join(
    process.cwd(),
    'out',
    'relay',
    `${process.platform}-${process.arch}`,
    'relay.js'
  )
  if (!existsSync(relayBundle)) {
    return {
      ok: false,
      reason: `Relay bundle missing at ${relayBundle}; run pnpm run build:relay.`
    }
  }
  const target = readPreflightSshTarget()
  const destination = target.configHost ?? `${target.username}@${target.host}`
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    ...(target.configHost ? [] : ['-p', String(target.port)]),
    // Why: probe with exactly the key the app will use, not whatever the agent happens to hold.
    ...(target.identityFile ? ['-i', target.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    destination,
    'true'
  ]
  const probe = spawnSync('ssh', args, { encoding: 'utf8', timeout: 20_000 })
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `ssh ${args.join(' ')} failed (status ${probe.status ?? 'n/a'}): ${
        probe.error?.message ?? probe.stderr.trim()
      }`
    }
  }
  return { ok: true, target }
}
