import { mocks, RUNTIME_ID } from './automations-page-test-harness'
import { CHAT_CAPABILITIES } from './automations-page-actions-test-harness'
import type { Repo } from '../../../../shared/repo-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'

export function observeRuntimeChat(capabilities: string[] | null): void {
  mocks.state.runtimeStatusByEnvironmentId = new Map(
    capabilities === null ? [] : [[RUNTIME_ID, { status: { capabilities } }]]
  )
}

export function capableChatDestination(): void {
  observeRuntimeChat(CHAT_CAPABILITIES)
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: CHAT_CAPABILITIES })
}

export const SSH_TARGET_ID = 'ssh-target-1'
export const SSH_REPO_ID = 'repo-ssh'
export const SSH_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

export const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})
export const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})

/** A desktop-registered SSH host, with the generation that makes it fenceable. */
export function addSshHost(): void {
  mocks.state.sshTargetLabels = new Map([[SSH_TARGET_ID, 'openclaw']])
  mocks.state.sshTargetGenerations = new Map([[SSH_TARGET_ID, 1]])
  mocks.state.sshConnectionStates = new Map([[SSH_TARGET_ID, { status: 'connected' }]])
}

/** A project checked out on that SSH host rather than locally. */
export function addSshProject(): void {
  const repo: Repo = {
    id: SSH_REPO_ID,
    displayName: 'orca',
    path: '/repos/orca',
    badgeColor: '#222222',
    addedAt: 1,
    worktreeBaseRef: 'main',
    connectionId: SSH_TARGET_ID
  }
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.repoMap.set(SSH_REPO_ID, repo)
  // The host needs a ready setup or save refuses the project before choosing a destination.
  mocks.state.projectHostSetups = [
    ...mocks.state.projectHostSetups,
    {
      id: 'setup-ssh',
      projectId: 'project-ssh',
      hostId: `ssh:${SSH_TARGET_ID}`,
      repoId: SSH_REPO_ID,
      path: '/repos/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
}
