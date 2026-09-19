import type { Page } from '@stablyai/playwright-test'
import type { SshTargetCreateInput } from '../../../src/shared/ssh-types'

export type ConnectedSshTestTarget = {
  targetId: string
  repoId: string
  worktreeId: string
}

type SshTestConnectionOptions = {
  remotePath: string
  displayName: string
  seedInitialTab?: boolean
}

export async function connectSshTestTarget(
  page: Page,
  target: SshTargetCreateInput,
  options: SshTestConnectionOptions
): Promise<ConnectedSshTestTarget> {
  return page.evaluate(
    async ({ target, remotePath, displayName, seedInitialTab }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const { target: createdTarget, repoReadoptions } = await window.api.ssh.addTarget({
          target
        })
        store.getState().recordSshRepoReadoptions(repoReadoptions)
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        if (
          !state.providerEpoch ||
          !Number.isSafeInteger(state.connectionGeneration) ||
          state.connectionGeneration === undefined ||
          state.connectionGeneration < 0
        ) {
          throw new Error(`SSH target returned incomplete authority: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)
        const executionHostId = `ssh:${encodeURIComponent(createdTarget.id)}` as const
        const authority = {
          targetId: createdTarget.id,
          providerEpoch: state.providerEpoch,
          connectionGeneration: state.connectionGeneration
        }

        const result = await window.api.repos.addRemote({
          connectionId: createdTarget.id,
          remotePath,
          displayName
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        const hasExpectedRepoOwner = (): boolean =>
          store
            .getState()
            .repos.some(
              (repo) =>
                repo.id === result.repo.id &&
                repo.connectionId === createdTarget.id &&
                repo.executionHostId === executionHostId
            )
        const waitForRepoOwner = async (): Promise<void> => {
          if (hasExpectedRepoOwner()) {
            return
          }
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              unsubscribe()
              reject(new Error(`Remote repo owner did not hydrate for ${result.repo.path}`))
            }, 15_000)
            const unsubscribe = store.subscribe((next) => {
              if (
                !next.repos.some(
                  (repo) =>
                    repo.id === result.repo.id &&
                    repo.connectionId === createdTarget.id &&
                    repo.executionHostId === executionHostId
                )
              ) {
                return
              }
              window.clearTimeout(timer)
              unsubscribe()
              resolve()
            })
          })
        }
        await store.getState().fetchRepos()
        await waitForRepoOwner()
        const currentState = store.getState().sshConnectionStates.get(createdTarget.id)
        if (
          currentState?.providerEpoch !== authority.providerEpoch ||
          currentState.connectionGeneration !== authority.connectionGeneration
        ) {
          throw new Error(`SSH authority rotated before worktree hydration for ${result.repo.path}`)
        }
        const worktreeResult = await store.getState().fetchWorktrees(result.repo.id, {
          executionHostId,
          directSshAuthority: authority,
          requireAuthoritative: true
        })
        if (
          worktreeResult.status !== 'complete' ||
          worktreeResult.repoId !== result.repo.id ||
          worktreeResult.authority.kind !== 'direct-ssh' ||
          worktreeResult.authority.executionHostId !== executionHostId ||
          worktreeResult.authority.targetId !== authority.targetId ||
          worktreeResult.authority.providerEpoch !== authority.providerEpoch ||
          worktreeResult.authority.connectionGeneration !== authority.connectionGeneration
        ) {
          throw new Error(
            `Remote worktree hydration was not authoritative: ${JSON.stringify(worktreeResult)}`
          )
        }
        const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? []).find(
          (candidate) => candidate.hostId === executionHostId
        )
        if (!worktree) {
          throw new Error(`No remote worktree found for ${result.repo.path}`)
        }
        store.getState().setActiveWorktree(worktree.id)
        if (seedInitialTab && (store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
          store.getState().createTab(worktree.id)
        }
        store.getState().setActiveTabType('terminal')
        return {
          targetId: createdTarget.id,
          repoId: result.repo.id,
          worktreeId: worktree.id
        }
      } finally {
        credentialUnsub()
      }
    },
    {
      target,
      remotePath: options.remotePath,
      displayName: options.displayName,
      seedInitialTab: options.seedInitialTab ?? true
    }
  )
}
