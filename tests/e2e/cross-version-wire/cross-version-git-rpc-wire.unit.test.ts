// Cross-version coverage for desktop↔host Git RPCs: current code against a real
// published release, in both skew directions, over one scripted status + mutation
// journey. Method lists and param schemas are read from each checkout — never
// "old side lacks X". Status result shape is stubbed, so this is not dropped-field CI.

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveBaselineReleaseRef } from './release-checkout'
import {
  gitMethodNames,
  loadGitRpcWireBuild,
  WORKING_TREE,
  type GitRpcWireBuild,
  type RpcClientIdentity,
  type RpcReply
} from './versioned-git-rpc-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000
const WORKTREE = 'id:wt-git-rpc'
const TRACKED_FILE = 'tracked.txt'
const ORIGINAL_CONTENTS = 'hello from the tracked file\n'
const MODIFIED_CONTENTS = 'hello from the tracked file\nchanged\n'
const GIT_IDENTITY = ['-c', 'user.email=cross-version@test', '-c', 'user.name=Cross Version']

let baselineRef: string
let current: GitRpcWireBuild
let baseline: GitRpcWireBuild
const tempRepos: string[] = []

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  current = await loadGitRpcWireBuild(WORKING_TREE)
  baseline = await loadGitRpcWireBuild(baselineRef)
}, SUITE_TIMEOUT_MS)

afterEach(async () => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createTrackedRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'orca-cross-version-git-rpc-'))
  tempRepos.push(repo)
  git(repo, ['init'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repo, TRACKED_FILE), ORIGINAL_CONTENTS)
  git(repo, ['add', '--', TRACKED_FILE])
  git(repo, [...GIT_IDENTITY, 'commit', '-m', 'init tracked file'])
  return repo
}

function gitRuntime(repo: string): unknown {
  return {
    getRuntimeId: () => 'cross-version-git-runtime',
    // Same stub for every build: dispatcher can run. Not a field-shape oracle.
    getRuntimeGitStatus: async () => readStatus(repo),
    stageRuntimeGitPath: async (_worktree: string, filePath: string) => {
      git(repo, ['add', '--', filePath])
      return { ok: true }
    },
    discardRuntimeGitPath: async (_worktree: string, filePath: string) => {
      // Why checkout HEAD: Git 2.25-safe; `restore` is unnecessary here.
      git(repo, ['checkout', 'HEAD', '--', filePath])
      return { ok: true }
    },
    commitRuntimeGit: async (_worktree: string, message: string) => {
      git(repo, [...GIT_IDENTITY, 'commit', '-m', message])
      return { success: true }
    }
  }
}

function readStatus(repo: string): Record<string, unknown> {
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const porcelain = git(repo, ['status', '--porcelain'])
  const entries = porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const xy = line.slice(0, 2)
      const path = line.slice(3)
      const staged = xy[0] !== ' ' && xy[0] !== '?'
      return {
        path,
        status: xy.includes('?') ? 'untracked' : 'modified',
        area: xy.includes('?') ? 'untracked' : staged ? 'staged' : 'unstaged'
      }
    })
  return { entries, conflictOperation: 'none', branch, head }
}

function clientIdentity(): RpcClientIdentity {
  return { clientKind: 'runtime' }
}

async function callGit(
  host: GitRpcWireBuild,
  runtime: unknown,
  method: string,
  params: unknown
): Promise<RpcReply> {
  const reply = await host
    .createDispatcher(runtime)
    .dispatch(
      { id: `git-${method}`, authToken: 'cross-version-token', method, params },
      clientIdentity()
    )
  expect(reply, `${host.label}: ${method} produced no reply`).toBeTruthy()
  return reply
}

function expectAnswered(reply: RpcReply, method: string, hostLabel: string): void {
  expect(reply, `${hostLabel}: ${method} hung or returned null`).toEqual(expect.any(Object))
  expect(
    reply.ok === true || reply.error?.code === 'method_not_found',
    `${hostLabel}: ${method} must be ok or method_not_found: ${JSON.stringify(reply)}`
  ).toBe(true)
}

/** Mutation both builds actually register. Prefer discard so the repo needs no identity. */
function sharedMutationMethod(): 'git.discard' | 'git.commit' {
  const currentGit = new Set(gitMethodNames(current))
  const baselineGit = new Set(gitMethodNames(baseline))
  if (currentGit.has('git.discard') && baselineGit.has('git.discard')) {
    return 'git.discard'
  }
  if (currentGit.has('git.commit') && baselineGit.has('git.commit')) {
    return 'git.commit'
  }
  throw new Error(
    'No shared git mutation (discard or commit) between working tree and baseline checkout'
  )
}

type JourneyRecord = {
  hostLabel: string
  clientLabel: string
  calls: { method: string; reply: RpcReply }[]
}

function paramsFor(method: string, client: GitRpcWireBuild): Record<string, unknown> {
  if (method === 'git.status') {
    // Current client may send optional fields; an old host strips unknown keys (Rule 1).
    // Old client omits newer keys; a newly required param fails old-client/new-host.
    return client.revision === WORKING_TREE
      ? { worktree: WORKTREE, includeLineStats: true }
      : { worktree: WORKTREE }
  }
  if (method === 'git.commit') {
    return { worktree: WORKTREE, message: 'cross-version git rpc journey' }
  }
  return { worktree: WORKTREE, filePath: TRACKED_FILE }
}

async function runJourney(args: {
  host: GitRpcWireBuild
  client: GitRpcWireBuild
  repo: string
}): Promise<JourneyRecord> {
  const runtime = gitRuntime(args.repo)
  const clientMethods = new Set(gitMethodNames(args.client))
  const hostMethods = new Set(gitMethodNames(args.host))
  const mutation = sharedMutationMethod()
  const record: JourneyRecord = {
    hostLabel: args.host.label,
    clientLabel: args.client.label,
    calls: []
  }

  const run = async (method: string): Promise<RpcReply> => {
    const reply = await callGit(args.host, runtime, method, paramsFor(method, args.client))
    expectAnswered(reply, method, args.host.label)
    if (!hostMethods.has(method)) {
      expect(reply, `${method} on host ${args.host.label}`).toMatchObject({
        ok: false,
        error: { code: 'method_not_found' }
      })
    } else {
      expect(
        reply.ok,
        `${method} is registered on ${args.host.label} but failed: ${JSON.stringify(reply)}`
      ).toBe(true)
    }
    record.calls.push({ method, reply })
    return reply
  }

  if (clientMethods.has('git.status')) {
    await run('git.status')
  }

  await writeFile(join(args.repo, TRACKED_FILE), MODIFIED_CONTENTS)

  if (clientMethods.has('git.status')) {
    await run('git.status')
  }

  if (clientMethods.has('git.stage')) {
    await run('git.stage')
  } else if (mutation === 'git.commit') {
    git(args.repo, ['add', '--', TRACKED_FILE])
  }

  if (clientMethods.has(mutation)) {
    await run(mutation)
  }

  return record
}

function expectJourneyRan(record: JourneyRecord, client: GitRpcWireBuild): void {
  const clientMethods = new Set(gitMethodNames(client))
  expect(
    record.calls.length,
    `${record.clientLabel} against ${record.hostLabel} ran nothing`
  ).toBeGreaterThan(0)
  if (clientMethods.has('git.status')) {
    expect(record.calls.some((call) => call.method === 'git.status')).toBe(true)
  }
}

describe('cross-version Git RPC journey', () => {
  it(
    'skews current code against a real published release',
    () => {
      expect(baselineRef).toMatch(/^v?\d/)
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
      expect(current.methodNames).toContain('git.status')
      expect(current.methodNames).toContain('git.stage')
      expect(current.methodNames).toContain('git.discard')
      expect(gitMethodNames(current).length).toBeGreaterThan(2)
      expect(gitMethodNames(baseline).length).toBeGreaterThan(0)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'current client against current host completes the journey',
    async () => {
      const repo = await createTrackedRepo()
      const record = await runJourney({ host: current, client: current, repo })
      expectJourneyRan(record, current)
      expect(record.calls.every((call) => call.reply.ok)).toBe(true)
      if (sharedMutationMethod() === 'git.discard') {
        expect(await readFile(join(repo, TRACKED_FILE), 'utf8')).toBe(ORIGINAL_CONTENTS)
      }
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against old host completes the journey',
    async () => {
      const repo = await createTrackedRepo()
      const record = await runJourney({ host: baseline, client: baseline, repo })
      expectJourneyRan(record, baseline)
      expect(record.calls.every((call) => call.reply.ok)).toBe(true)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'new client against old host gets an answer rather than silence',
    async () => {
      const repo = await createTrackedRepo()
      const record = await runJourney({ host: baseline, client: current, repo })
      expectJourneyRan(record, current)
      const registered = new Set(gitMethodNames(baseline))
      for (const call of record.calls) {
        expectAnswered(call.reply, call.method, baseline.label)
        if (!registered.has(call.method)) {
          expect(call.reply.error?.code).toBe('method_not_found')
        }
      }
      for (const method of gitMethodNames(current)) {
        if (registered.has(method)) {
          continue
        }
        const reply = await callGit(baseline, gitRuntime(repo), method, { worktree: WORKTREE })
        expect(reply, `${method} on the old host`).toMatchObject({
          ok: false,
          error: { code: 'method_not_found' }
        })
      }
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new host completes the journey the old client can name',
    async () => {
      const referenceRepo = await createTrackedRepo()
      const reference = await runJourney({ host: current, client: current, repo: referenceRepo })
      const repo = await createTrackedRepo()
      const record = await runJourney({ host: current, client: baseline, repo })
      expectJourneyRan(record, baseline)
      expect(record.calls.every((call) => call.reply.ok)).toBe(true)
      const oldClientMethods = new Set(gitMethodNames(baseline))
      expect(record.calls.map((call) => call.method)).toEqual(
        reference.calls.map((call) => call.method).filter((method) => oldClientMethods.has(method))
      )
    },
    SUITE_TIMEOUT_MS
  )
})
