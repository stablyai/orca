import { describe, expect, it } from 'vitest'
import {
  findSetupScriptPromptRepo,
  getRenderedSetupScriptPromptState,
  markSetupScriptPromptSaved
} from './setup-script-prompt-render-state'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'
import type { Repo } from '../../../../shared/repo-types'

function repoIdentity(repoId: string, hostId: string): string {
  return getRepoHostIdentityForParts(repoId, hostId)
}

function prompt(
  repoId: string,
  hostId: string
): SetupScriptPromptInspection & { repoHostIdentity: string } {
  return {
    status: 'ok',
    repoId,
    repoHostIdentity: repoIdentity(repoId, hostId),
    hasEffectiveSetup: false,
    hasSharedHooks: false,
    candidate: null
  }
}

describe('findSetupScriptPromptRepo', () => {
  it('uses the active direct-SSH worktree host when repo ids collide', () => {
    const local: Repo = {
      id: 'same-repo',
      path: '/local',
      displayName: 'Local',
      badgeColor: '#000',
      addedAt: 1
    }
    const ssh: Repo = {
      ...local,
      path: '/ssh',
      displayName: 'SSH',
      connectionId: 'server',
      executionHostId: 'ssh:server'
    }

    expect(
      findSetupScriptPromptRepo({
        repos: [local, ssh],
        activeRepoId: 'same-repo',
        activeWorktree: { repoId: 'same-repo', hostId: 'ssh:server' },
        settings: { activeRuntimeEnvironmentId: null }
      })
    ).toBe(ssh)
  })

  it('uses the runtime owner for a relayed SSH worktree', () => {
    const directSsh: Repo = {
      id: 'same-repo',
      path: '/direct',
      displayName: 'Direct SSH',
      badgeColor: '#000',
      addedAt: 1,
      connectionId: 'private'
    }
    const runtime: Repo = {
      ...directSsh,
      path: '/runtime',
      displayName: 'Runtime',
      executionHostId: 'runtime:hub'
    }

    expect(
      findSetupScriptPromptRepo({
        repos: [directSsh, runtime],
        activeRepoId: 'same-repo',
        activeWorktree: {
          repoId: 'same-repo',
          hostId: 'ssh:private',
          runtimeOwnerEnvironmentId: 'hub'
        },
        settings: { activeRuntimeEnvironmentId: null }
      })
    ).toBe(runtime)
  })
})

describe('getRenderedSetupScriptPromptState', () => {
  it('uses the current inspection when it belongs to the active repo and host', () => {
    const current = prompt('repo-local', 'local')

    expect(
      getRenderedSetupScriptPromptState({
        promptState: current,
        activeRepoId: 'repo-local',
        activeRepoHostIdentity: repoIdentity('repo-local', 'local'),
        lastVisiblePrompt: {
          state: prompt('repo-ssh', 'ssh:windows')
        }
      })
    ).toBe(current)
  })

  it('keeps the previous visible prompt during same-host inspection refresh', () => {
    const previous = prompt('repo-local', 'local')

    expect(
      getRenderedSetupScriptPromptState({
        promptState: null,
        activeRepoId: 'repo-local',
        activeRepoHostIdentity: repoIdentity('repo-local', 'local'),
        lastVisiblePrompt: { state: previous }
      })
    ).toBe(previous)
  })

  it('does not keep a stale prompt when switching hosts in the same project', () => {
    expect(
      getRenderedSetupScriptPromptState({
        promptState: null,
        activeRepoId: 'repo-windows',
        activeRepoHostIdentity: repoIdentity('repo-windows', 'runtime:windows'),
        lastVisiblePrompt: {
          state: prompt('repo-local', 'local')
        }
      })
    ).toBeNull()
  })

  it('does not reuse a matching repo id from a different host', () => {
    expect(
      getRenderedSetupScriptPromptState({
        promptState: prompt('repo-orca', 'local'),
        activeRepoId: 'repo-orca',
        activeRepoHostIdentity: repoIdentity('repo-orca', 'runtime:windows'),
        lastVisiblePrompt: null
      })
    ).toBeNull()
  })

  it('does not keep a stale prompt when switching to a different project', () => {
    expect(
      getRenderedSetupScriptPromptState({
        promptState: null,
        activeRepoId: 'repo-other',
        activeRepoHostIdentity: repoIdentity('repo-other', 'local'),
        lastVisiblePrompt: {
          state: prompt('repo-local', 'local')
        }
      })
    ).toBeNull()
  })
})

describe('markSetupScriptPromptSaved', () => {
  it('does not apply a completed save to the same repo id on another host', () => {
    const remote = prompt('repo-orca', 'runtime:windows')

    expect(markSetupScriptPromptSaved(remote, repoIdentity('repo-orca', 'local'))).toBe(remote)
  })

  it('marks the prompt for the saved host effective', () => {
    expect(
      markSetupScriptPromptSaved(
        prompt('repo-orca', 'runtime:windows'),
        repoIdentity('repo-orca', 'runtime:windows')
      )
    ).toMatchObject({ hasEffectiveSetup: true })
  })
})
