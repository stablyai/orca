import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/protocol-version'
import { bulkDiscardStagedRuntimeGitPaths } from './runtime-git-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

type RepoSnapshot = {
  index: Buffer
  cachedDiff: string
  status: string
  worktree: Buffer
}

const repos: string[] = []

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function createStagedRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'orca-staged-discard-skew-'))
  repos.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'staged-discard@example.invalid')
  git(repo, 'config', 'user.name', 'Staged Discard')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(path.join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-qm', 'base')
  writeFileSync(path.join(repo, 'file.txt'), 'staged\n')
  git(repo, 'add', 'file.txt')
  writeFileSync(path.join(repo, 'file.txt'), 'staged\nunstaged\n')
  return repo
}

function snapshot(repo: string): RepoSnapshot {
  return {
    index: readFileSync(path.join(repo, '.git', 'index')),
    cachedDiff: git(repo, 'diff', '--cached', '--binary'),
    status: git(repo, 'status', '--porcelain=v1', '-z'),
    worktree: readFileSync(path.join(repo, 'file.txt'))
  }
}

function statusResponse(capabilities: unknown) {
  const response = createCompatibleRuntimeStatusResponse()
  if (!response.ok) {
    throw new Error('Expected compatible status response')
  }
  return { ...response, result: { ...response.result, capabilities } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true })
  }
})

describe('staged discard mixed-version safety', () => {
  it.each([
    ['absent', undefined],
    ['malformed', GIT_STAGED_DISCARD_RUNTIME_CAPABILITY],
    ['unsupported', ['git.staged-discard.v1']],
    ['mixed malformed', [GIT_STAGED_DISCARD_RUNTIME_CAPABILITY, 1]]
  ])('new client rejects an %s old-host proof without changing Git bytes', async (_, proof) => {
    const repo = createStagedRepo()
    const before = snapshot(repo)
    const call = vi.fn(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return statusResponse(proof)
      }
      throw new Error(`unexpected mutation ${args.method}`)
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call }, runtime: { call: vi.fn() }, git: {} }
    })

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: 'old-host' },
          worktreeId: 'wt-1',
          worktreePath: repo
        },
        ['file.txt']
      )
    ).rejects.toThrow(GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE)

    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toMatchObject({ method: 'status.get' })
    expect(snapshot(repo)).toEqual(before)
  })

  it('keeps Git bytes unchanged when a claimed host rejects the versioned operation', async () => {
    const repo = createStagedRepo()
    const before = snapshot(repo)
    const call = vi.fn(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return statusResponse([GIT_STAGED_DISCARD_RUNTIME_CAPABILITY])
      }
      return {
        id: 'rpc-staged-discard',
        ok: false as const,
        error: { code: 'invalid_argument', message: 'unsupported staged discard version' },
        _meta: { runtimeId: 'old-host' }
      }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call }, runtime: { call: vi.fn() }, git: {} }
    })

    await expect(
      bulkDiscardStagedRuntimeGitPaths(
        {
          settings: { activeRuntimeEnvironmentId: 'old-host' },
          worktreeId: 'wt-1',
          worktreePath: repo
        },
        ['file.txt']
      )
    ).rejects.toThrow('unsupported staged discard version')

    expect(call.mock.calls.map(([args]) => args.method)).toEqual([
      'status.get',
      'git.bulkDiscardStaged'
    ])
    expect(snapshot(repo)).toEqual(before)
  })
})
