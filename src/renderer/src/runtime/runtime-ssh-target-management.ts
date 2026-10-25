import type { Repo } from '../../../shared/repo-types'
import {
  SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY,
  type SshEditableTarget,
  type SshEditableTargetAddResult,
  type SshEditableTargetInput
} from '../../../shared/ssh-target-management'
import type { FilesystemPathFlavor } from '../../../shared/filesystem-entry-types'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/** The paired server predates server SSH management; the caller shows "update the server". */
export class RuntimeSshTargetManagementUnsupportedError extends Error {
  constructor() {
    super('Update this Orca server to manage its SSH hosts from here.')
    this.name = 'RuntimeSshTargetManagementUnsupportedError'
  }
}

export function runtimeSupportsSshTargetManagement(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY
  )
}

// Why every call checks: an old server would answer method_not_found at best; there is never a
// local fallback, because this client's own SSH hosts are a different machine's.
async function callSshTargetManagement<T>(
  environmentId: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<T> {
  if (!(await runtimeSupportsSshTargetManagement(environmentId))) {
    throw new RuntimeSshTargetManagementUnsupportedError()
  }
  return callRuntimeRpc<T>(
    { kind: 'environment', environmentId },
    method,
    params,
    timeoutMs === undefined ? {} : { timeoutMs }
  )
}

export async function listRuntimeEditableSshTargets(
  environmentId: string
): Promise<SshEditableTarget[]> {
  const result = await callSshTargetManagement<{ targets: SshEditableTarget[] }>(
    environmentId,
    'ssh.listEditableTargets'
  )
  return result.targets
}

export function addRuntimeSshTarget(
  environmentId: string,
  target: SshEditableTargetInput
): Promise<SshEditableTargetAddResult> {
  return callSshTargetManagement(environmentId, 'ssh.addTarget', { target })
}

export async function updateRuntimeSshTarget(
  environmentId: string,
  targetId: string,
  target: SshEditableTargetInput
): Promise<SshEditableTarget> {
  const result = await callSshTargetManagement<{ target: SshEditableTarget }>(
    environmentId,
    'ssh.updateTarget',
    { targetId, target }
  )
  return result.target
}

export async function removeRuntimeSshTarget(
  environmentId: string,
  targetId: string
): Promise<void> {
  await callSshTargetManagement(environmentId, 'ssh.removeTarget', { targetId })
}

export type RuntimeSshDirectoryListing = {
  entries: { name: string; isDirectory: boolean }[]
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
}

export function browseRuntimeSshDirectory(
  environmentId: string,
  targetId: string,
  dirPath: string
): Promise<RuntimeSshDirectoryListing> {
  // Why 20s: the server bounds its own SSH listing at 15s.
  return callSshTargetManagement(environmentId, 'ssh.browseDir', { targetId, dirPath }, 20_000)
}

export async function addRuntimeSshRepo(
  environmentId: string,
  args: { connectionId: string; remotePath: string; displayName?: string; kind?: 'git' | 'folder' }
): Promise<Repo> {
  const result = await callSshTargetManagement<{ repo: Repo }>(
    environmentId,
    'repo.addRemote',
    args
  )
  return result.repo
}
