/**
 * Durable SSH remote-PTY leases, read straight off the profile state file.
 *
 * Why the file: no renderer channel exposes leases, and the lease is the only
 * record that says whether reconnect's reattach fan-out actually reached a
 * given remote PTY. Without it, a reattach that silently skipped a PTY looks
 * exactly like a reattach that correctly refused to bind it.
 */
import type { ElectronApplication } from '@stablyai/playwright-test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SshRemotePtyLease } from '../../../src/shared/ssh-types'

/** Path of the running app's active-profile state file. */
export async function resolveOrcaProfileStateFile(app: ElectronApplication): Promise<string> {
  const userDataPath = await app.evaluate(({ app }) => app.getPath('userData'))
  const indexPath = path.join(userDataPath, 'orca-profile-index.json')
  if (existsSync(indexPath)) {
    const activeProfileId = (
      JSON.parse(readFileSync(indexPath, 'utf-8')) as {
        activeProfileId?: string
      }
    ).activeProfileId
    const profileFile = activeProfileId
      ? path.join(userDataPath, 'profiles', activeProfileId, 'orca-data.json')
      : null
    if (profileFile && existsSync(profileFile)) {
      return profileFile
    }
  }
  // Pre-profile layout: the state file sits directly under userData.
  const legacyFile = path.join(userDataPath, 'orca-data.json')
  if (existsSync(legacyFile)) {
    return legacyFile
  }
  throw new Error(`No Orca profile state file under ${userDataPath}`)
}

export function readSshRemotePtyLeases(stateFile: string, targetId: string): SshRemotePtyLease[] {
  const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
    sshRemotePtyLeases?: SshRemotePtyLease[]
  }
  return (parsed.sshRemotePtyLeases ?? []).filter((lease) => lease.targetId === targetId)
}

/** The lease a pane owns, by pane identity — lease `ptyId`s are relay-local and unstable across ids. */
export function findSshRemotePtyLeaseForLeaf(
  stateFile: string,
  targetId: string,
  leafId: string
): SshRemotePtyLease | undefined {
  return readSshRemotePtyLeases(stateFile, targetId).find((lease) => lease.leafId === leafId)
}

export function describeSshRemotePtyLeases(leases: readonly SshRemotePtyLease[]): string {
  return leases
    .map(
      (lease) =>
        `${lease.ptyId} ${lease.state} leaf=${lease.leafId ?? '-'} attachedAt=${lease.lastAttachedAt ?? '-'}`
    )
    .join(', ')
}
