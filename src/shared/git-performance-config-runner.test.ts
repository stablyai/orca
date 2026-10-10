import { describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from './git-capability-cache'
import {
  isFsmonitorDaemonUnsupportedError,
  probeFsmonitorDaemon,
  runGitPerformanceConfigAction,
  type GitPerformanceConfigHost
} from './git-performance-config-runner'

type FakeRepo = {
  local: [string, string][]
  global: [string, string][]
  version: string
  fsmonitorStatus: () => Promise<{ stdout: string; stderr: string }>
  calls: string[][]
}

function gitError(code: number, stderr = '', stdout = ''): Error {
  return Object.assign(new Error(stderr || `exit ${code}`), { code, stderr, stdout })
}

function fakeHost(repo: FakeRepo, capabilities = new GitCapabilityCache()) {
  const matches = (pattern: string) => (name: string) =>
    new RegExp(pattern).test(name.toLowerCase())
  const git = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    repo.calls.push(args)
    if (args[0] === '--version') {
      return { stdout: repo.version, stderr: '' }
    }
    if (args[0] === 'fsmonitor--daemon') {
      return repo.fsmonitorStatus()
    }
    if (args[0] === 'rev-parse') {
      return { stdout: '.git/index\n', stderr: '' }
    }
    if (args[0] !== 'config') {
      throw gitError(128, `unexpected ${args.join(' ')}`)
    }
    const local = args[1] === '--local'
    const rest = local ? args.slice(2) : args.slice(1)
    if (rest[0] === '-z' && rest[1] === '--get-regexp') {
      const source = local ? repo.local : [...repo.global, ...repo.local]
      const hits = source.filter(([name]) => matches(rest[2])(name))
      if (hits.length === 0) {
        throw gitError(1)
      }
      return {
        stdout: hits.map(([name, value]) => `${name.toLowerCase()}\n${value}\0`).join(''),
        stderr: ''
      }
    }
    if (rest[0] === '--add') {
      repo.local.push([rest[1], rest[2]])
      return { stdout: '', stderr: '' }
    }
    if (rest[0] === '--unset' || rest[0] === '--unset-all') {
      const name = rest[1].toLowerCase()
      const pattern = rest[2] ? new RegExp(rest[2]) : null
      const before = repo.local.length
      repo.local = repo.local.filter(
        ([key, value]) => key.toLowerCase() !== name || (pattern !== null && !pattern.test(value))
      )
      if (repo.local.length === before) {
        throw gitError(5)
      }
      return { stdout: '', stderr: '' }
    }
    repo.local = repo.local.filter(([key]) => key.toLowerCase() !== rest[0].toLowerCase())
    repo.local.push([rest[0], rest[1]])
    return { stdout: '', stderr: '' }
  }
  const host: GitPerformanceConfigHost = {
    platform: 'darwin',
    git,
    capabilities,
    hasReliableDirectoryMtime: async () => true,
    resolveGitPath: () => '/nonexistent/orca-index-for-test'
  }
  return host
}

function newRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    local: [],
    global: [],
    version: 'git version 2.50.1\n',
    fsmonitorStatus: async () => {
      throw gitError(1, '', "fsmonitor-daemon is not watching '/repo'\n")
    },
    calls: [],
    ...overrides
  }
}

describe('runGitPerformanceConfigAction', () => {
  it('records each key before writing it, then reverts exactly those keys', async () => {
    const repo = newRepo({ global: [['fetch.writeCommitGraph', 'false']] })
    const host = fakeHost(repo)

    const applied = await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })

    expect(applied.state.orcaKeys).toEqual([
      { key: 'core.untrackedCache', value: 'true' },
      { key: 'core.fsmonitor', value: 'true' },
      { key: 'checkout.workers', value: '0' }
    ])
    expect(applied.state.userKeys).toEqual(['fetch.writeCommitGraph'])
    const writes = repo.calls.filter(
      (args) => args[0] === 'config' && !args.includes('--get-regexp')
    )
    expect(writes.slice(0, 2)).toEqual([
      ['config', '--local', '--add', 'orca.performanceConfig', 'core.untrackedCache=true'],
      ['config', '--local', 'core.untrackedCache', 'true']
    ])

    // The user changes one Orca value by hand before switching the setting off.
    repo.local = repo.local.map(([key, value]): [string, string] =>
      key === 'checkout.workers' ? [key, '8'] : [key, value]
    )
    const reverted = await runGitPerformanceConfigAction(host, 'revert')

    expect(reverted.reverted).toEqual(['core.untrackedCache', 'core.fsmonitor'])
    expect(repo.local).toEqual([['checkout.workers', '8']])
    expect(reverted.state).toEqual({
      orcaKeys: [],
      userKeys: ['checkout.workers', 'fetch.writeCommitGraph']
    })
  })

  it('is idempotent: a second apply writes nothing', async () => {
    const repo = newRepo()
    const host = fakeHost(repo)
    await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })
    repo.calls = []
    const second = await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })
    expect(repo.calls.some((args) => args[0] === 'config' && !args.includes('--get-regexp'))).toBe(
      false
    )
    expect(second.plan?.filter((entry) => entry.action === 'keep')).toHaveLength(4)
  })

  it('never probes or writes the file watcher without its own opt-in', async () => {
    const repo = newRepo()
    const result = await runGitPerformanceConfigAction(fakeHost(repo), 'apply')
    expect(repo.calls.some((args) => args[0] === 'fsmonitor--daemon')).toBe(false)
    expect(result.plan?.find((entry) => entry.key === 'core.fsmonitor')).toEqual({
      key: 'core.fsmonitor',
      action: 'skip',
      reason: 'not-opted-in'
    })
    expect(repo.local.some(([key]) => key === 'core.fsmonitor')).toBe(false)
  })

  it('takes back only the file watcher when the opt-in is withdrawn', async () => {
    const repo = newRepo()
    const host = fakeHost(repo)
    await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })

    const reverted = await runGitPerformanceConfigAction(host, 'revert', {
      keys: ['core.fsmonitor']
    })
    expect(reverted.reverted).toEqual(['core.fsmonitor'])
    expect(reverted.state.orcaKeys.map((entry) => entry.key)).toEqual([
      'core.untrackedCache',
      'checkout.workers',
      'fetch.writeCommitGraph'
    ])
    expect(repo.local.filter(([key]) => key === 'orca.performanceConfig')).toHaveLength(3)

    // A later apply without the opt-in also removes a watcher Orca set earlier.
    await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })
    const reapplied = await runGitPerformanceConfigAction(host, 'apply')
    expect(reapplied.state.orcaKeys.map((entry) => entry.key)).not.toContain('core.fsmonitor')
    expect(repo.local.some(([key]) => key === 'core.fsmonitor')).toBe(false)
  })

  it('inspect never writes and never probes', async () => {
    const repo = newRepo()
    await runGitPerformanceConfigAction(fakeHost(repo), 'inspect')
    expect(repo.calls.every((args) => args[0] === 'config' && args.includes('--get-regexp'))).toBe(
      true
    )
  })
})

describe('fsmonitor daemon capability', () => {
  const notACommand = () =>
    Promise.reject(
      gitError(1, "git: 'fsmonitor--daemon' is not a git command. See 'git --help'.\n")
    )

  it('recognizes only the unsupported-daemon errors', () => {
    expect(
      isFsmonitorDaemonUnsupportedError(
        gitError(128, 'fatal: fsmonitor--daemon not supported on this platform')
      )
    ).toBe(true)
    expect(
      isFsmonitorDaemonUnsupportedError(
        gitError(1, "git: 'fsmonitor--daemon' is not a git command.")
      )
    ).toBe(true)
    expect(isFsmonitorDaemonUnsupportedError(gitError(128, 'fatal: not a git repository'))).toBe(
      false
    )
  })

  it('falls back on the first unsupported answer and serves later calls from the cache', async () => {
    const capabilities = new GitCapabilityCache()
    const repo = newRepo({ fsmonitorStatus: vi.fn(notACommand) })
    const host = fakeHost(repo, capabilities)

    await expect(probeFsmonitorDaemon(host)).resolves.toBe('unsupported')
    await expect(probeFsmonitorDaemon(host)).resolves.toBe('unsupported')
    expect(repo.fsmonitorStatus).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent probes behind one unsupported answer', async () => {
    const capabilities = new GitCapabilityCache()
    let rejectStatus!: (error: Error) => void
    const status = vi.fn(
      () =>
        new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
          rejectStatus = reject
        })
    )
    const host = fakeHost(newRepo({ fsmonitorStatus: status }), capabilities)

    const first = probeFsmonitorDaemon(host)
    const second = probeFsmonitorDaemon(host)
    rejectStatus(gitError(128, 'fatal: fsmonitor--daemon not supported on this platform'))

    await expect(Promise.all([first, second])).resolves.toEqual(['unsupported', 'unsupported'])
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('keeps a per-repository incompatibility out of the host capability', async () => {
    const capabilities = new GitCapabilityCache()
    const remote = fakeHost(
      newRepo({
        fsmonitorStatus: () =>
          Promise.reject(
            gitError(
              128,
              "fatal: remote repository '/Volumes/share' is incompatible with fsmonitor"
            )
          )
      }),
      capabilities
    )
    const local = fakeHost(newRepo(), capabilities)

    await expect(probeFsmonitorDaemon(remote)).resolves.toBe('incompatible')
    await expect(probeFsmonitorDaemon(local)).resolves.toBe('compatible')
    expect(capabilities.isKnownSupported('fsmonitor-daemon')).toBe(true)
  })

  it('isolates hosts: an unsupported relay does not disable the native host', async () => {
    const relay = fakeHost(newRepo({ fsmonitorStatus: notACommand }), new GitCapabilityCache())
    const native = fakeHost(newRepo(), new GitCapabilityCache())

    await expect(probeFsmonitorDaemon(relay)).resolves.toBe('unsupported')
    await expect(probeFsmonitorDaemon(native)).resolves.toBe('compatible')
  })

  it.each([
    ['linux', 'git version 2.50.1\n'],
    ['darwin', 'git version 2.36.6\n']
  ] as const)('does not probe on %s with %j', async (platform, version) => {
    const repo = newRepo({ version })
    const host: GitPerformanceConfigHost = { ...fakeHost(repo), platform }
    const result = await runGitPerformanceConfigAction(host, 'apply', { fsmonitor: true })
    expect(repo.calls.some((args) => args[0] === 'fsmonitor--daemon')).toBe(false)
    expect(result.plan?.find((entry) => entry.key === 'core.fsmonitor')).toMatchObject({
      action: 'skip'
    })
  })
})
