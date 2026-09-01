import type { Page } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it } from 'vitest'
import type { DockerSshRelayTarget } from './docker-ssh-relay-target'
import { connectDockerRemoteWorktree } from './docker-ssh-custom-agent-remote'

// The connect routine runs inside page.evaluate, so it can only reach `window`.
// Running its callback against a stubbed window is what proves it consumes the
// real IPC result shapes — a mis-read wrapper here made all four SSH
// custom-agent specs fail with `SSH target "undefined" not found` before
// reaching the feature.
const TARGET_ID = 'ssh-target-1'
const EXECUTION_HOST_ID = `ssh:${TARGET_ID}`

type FetchWorktreesCall = { repoId: string; executionHostId?: string }
type AddedTarget = { host: string; port: number }

function stubWindow(): {
  addedTargets: AddedTarget[]
  connectedTargetIds: string[]
  fetchWorktreesCalls: FetchWorktreesCall[]
} {
  const addedTargets: AddedTarget[] = []
  const connectedTargetIds: string[] = []
  const fetchWorktreesCalls: FetchWorktreesCall[] = []
  const state = {
    setSshConnectionState: () => {},
    sshTargetLabels: new Map<string, string>(),
    setSshTargetLabels: () => {},
    recordSshRepoReadoptions: () => {},
    fetchRepos: async () => {},
    fetchWorktrees: async (repoId: string, options?: { executionHostId?: string }) => {
      fetchWorktreesCalls.push({ repoId, executionHostId: options?.executionHostId })
      return true
    },
    worktreesByRepo: {
      'repo-1': [
        { id: 'local-worktree', hostId: 'local' },
        { id: 'remote-worktree', hostId: EXECUTION_HOST_ID }
      ]
    },
    setActiveWorktree: () => {}
  }
  const fakeWindow = {
    __store: { getState: () => state },
    api: {
      ssh: {
        onCredentialRequest: () => () => {},
        submitCredential: async () => {},
        addTarget: async ({ target }: { target: AddedTarget }) => {
          addedTargets.push({ host: target.host, port: target.port })
          return {
            target: { id: TARGET_ID, label: 'Docker SSH Custom Agent' },
            repoReadoptions: []
          }
        },
        // Mirrors the real handler: an unknown target id never reports connected.
        connect: async ({ targetId }: { targetId: string }) => {
          connectedTargetIds.push(targetId)
          return targetId === TARGET_ID
            ? { status: 'connected', providerEpoch: 'epoch-1', connectionGeneration: 0 }
            : { status: 'error', error: `SSH target "${targetId}" not found` }
        }
      },
      repos: {
        addRemote: async () => ({ repo: { id: 'repo-1', path: '/srv/repo' } })
      }
    }
  }
  ;(globalThis as unknown as { window?: unknown }).window = fakeWindow
  return { addedTargets, connectedTargetIds, fetchWorktreesCalls }
}

const fakePage = {
  evaluate: async <Arg, Result>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg) => fn(arg)
} as unknown as Page

// A non-loopback host, as ORCA_E2E_SSH_TARGET_HOST produces for non-local runners.
const fakeTarget = {
  containerName: 'orca-e2e',
  host: '10.1.2.3',
  port: 2222,
  identityFile: '/tmp/id_ed25519'
} as DockerSshRelayTarget

describe('connectDockerRemoteWorktree', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('connects the target returned inside the add result, not the result itself', async () => {
    const { connectedTargetIds } = stubWindow()

    const connected = await connectDockerRemoteWorktree(fakePage, fakeTarget)

    expect(connectedTargetIds).toEqual([TARGET_ID])
    expect(connected).toEqual({
      targetId: TARGET_ID,
      repoId: 'repo-1',
      worktreeId: 'remote-worktree'
    })
  })

  it('hydrates and selects the worktree on the SSH execution host', async () => {
    const { fetchWorktreesCalls } = stubWindow()

    await connectDockerRemoteWorktree(fakePage, fakeTarget)

    expect(fetchWorktreesCalls).toEqual([{ repoId: 'repo-1', executionHostId: EXECUTION_HOST_ID }])
  })

  it('adds the container address the fixture published', async () => {
    const { addedTargets } = stubWindow()

    await connectDockerRemoteWorktree(fakePage, fakeTarget)

    expect(addedTargets).toEqual([{ host: fakeTarget.host, port: fakeTarget.port }])
  })
})
