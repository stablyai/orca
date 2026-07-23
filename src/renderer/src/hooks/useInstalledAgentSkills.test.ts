import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../shared/skills'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  MAX_CACHED_SKILL_DISCOVERY_TARGETS,
  MAX_PENDING_SKILL_DISCOVERY_TARGETS,
  _installedAgentSkillDiscoveryInternalsForTests,
  hasInstalledAgentSkill,
  hasInstalledAgentSkillNamed
} from './useInstalledAgentSkills'
import { InstalledSkillDiscoveryCoordinator } from './installed-skill-discovery-coordinator'

afterEach(() => {
  _installedAgentSkillDiscoveryInternalsForTests.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'Example Skill',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/example-skill',
    skillFilePath: '/Users/test/.agents/skills/example-skill/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function discoveryResult(skills: DiscoveredSkill[] = []): SkillDiscoveryResult {
  return {
    skills,
    sources: [],
    scannedAt: Date.now()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('hasInstalledAgentSkill', () => {
  it('matches installed skills by summarized name', () => {
    expect(hasInstalledAgentSkill([skill({ name: 'orca-cli' })], 'orca-cli')).toBe(true)
  })

  it('matches installed skills by directory name when frontmatter has a display name', () => {
    expect(
      hasInstalledAgentSkill(
        [
          skill({
            name: 'Orca CLI',
            directoryPath: 'C:\\Users\\test\\.agents\\skills\\orca-cli'
          })
        ],
        'orca-cli'
      )
    ).toBe(true)
  })

  it('ignores non-installed discovery entries', () => {
    expect(
      hasInstalledAgentSkill([skill({ name: 'orca-cli', installed: false })], 'orca-cli')
    ).toBe(false)
  })

  it('does not count repo or plugin skills when matching global installs', () => {
    expect(
      hasInstalledAgentSkill(
        [
          skill({
            name: 'orca-cli',
            sourceKind: 'repo',
            sourceLabel: 'Repo test .agents',
            rootPath: '/repo/.agents/skills',
            directoryPath: '/repo/.agents/skills/orca-cli',
            skillFilePath: '/repo/.agents/skills/orca-cli/SKILL.md'
          }),
          skill({
            id: 'skill-2',
            name: 'orca-cli',
            sourceKind: 'plugin',
            sourceLabel: 'Codex plugin cache',
            rootPath: '/Users/test/.codex/plugins/cache',
            directoryPath: '/Users/test/.codex/plugins/cache/vendor/orca-cli',
            skillFilePath: '/Users/test/.codex/plugins/cache/vendor/orca-cli/SKILL.md'
          })
        ],
        'orca-cli',
        { sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS }
      )
    ).toBe(false)
  })

  it('counts home skills when matching global installs', () => {
    expect(
      hasInstalledAgentSkill([skill({ name: 'orca-cli' })], 'orca-cli', {
        sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
      })
    ).toBe(true)
  })

  it('matches installed skills by any accepted name', () => {
    expect(
      hasInstalledAgentSkillNamed(
        [skill({ name: 'linear-tickets' })],
        ['orca-linear', 'linear-tickets']
      )
    ).toBe(true)
  })

  it('matches accepted names by POSIX directory basename', () => {
    expect(
      hasInstalledAgentSkillNamed(
        [
          skill({
            name: 'Linear Tickets',
            directoryPath: '/Users/test/.agents/skills/linear-tickets'
          })
        ],
        ['orca-linear', 'linear-tickets']
      )
    ).toBe(true)
  })

  it('matches accepted names by Windows directory basename', () => {
    expect(
      hasInstalledAgentSkillNamed(
        [
          skill({
            name: 'Linear Tickets',
            directoryPath: 'C:\\Users\\test\\.agents\\skills\\orca-linear'
          })
        ],
        ['orca-linear', 'linear-tickets']
      )
    ).toBe(true)
  })

  it('keeps aliases opt-in for unrelated single-name checks', () => {
    expect(hasInstalledAgentSkill([skill({ name: 'linear-tickets' })], 'orca-linear')).toBe(false)
  })
})

describe('isOrchestrationSkillName', () => {
  it('matches only the orchestration skill name', () => {
    expect(
      _installedAgentSkillDiscoveryInternalsForTests.isOrchestrationSkillName('orchestration')
    ).toBe(true)
    expect(
      _installedAgentSkillDiscoveryInternalsForTests.isOrchestrationSkillName(' Orchestration ')
    ).toBe(true)
    expect(
      _installedAgentSkillDiscoveryInternalsForTests.isOrchestrationSkillName('computer-use')
    ).toBe(false)
  })
})

describe('discoverInstalledAgentSkills', () => {
  const projectWslRuntime: ProjectExecutionRuntimeResolution = {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: 'repo-1',
      distro: 'Ubuntu',
      reason: 'project-override',
      cacheKey: 'repo-1:wsl:Ubuntu'
    }
  }

  const projectHostRuntime: ProjectExecutionRuntimeResolution = {
    status: 'resolved',
    runtime: {
      kind: 'windows-host',
      hostPlatform: 'win32',
      projectId: 'repo-1',
      reason: 'project-override',
      cacheKey: 'repo-1:windows-host'
    }
  }

  it('starts a fresh scan when a forced refresh arrives during a background scan', async () => {
    const firstScan = deferred<SkillDiscoveryResult>()
    const secondScan = deferred<SkillDiscoveryResult>()
    const discover = vi.fn<() => Promise<SkillDiscoveryResult>>()
    discover.mockReturnValueOnce(firstScan.promise)
    discover.mockReturnValueOnce(secondScan.promise)
    vi.stubGlobal('window', {
      api: { skills: { discover } }
    })

    const backgroundRefresh =
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false)
    const forcedRefresh =
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(true)

    expect(discover).toHaveBeenCalledTimes(1)

    const staleResult = discoveryResult([])
    firstScan.resolve(staleResult)
    await expect(backgroundRefresh).resolves.toBe(staleResult)

    expect(discover).toHaveBeenCalledTimes(2)

    const freshResult = discoveryResult([skill({ name: 'orca-cli' })])
    secondScan.resolve(freshResult)
    await expect(forcedRefresh).resolves.toBe(freshResult)
  })

  it('caches host and WSL discovery results separately', async () => {
    const hostResult = discoveryResult([skill({ name: 'host-skill' })])
    const wslResult = discoveryResult([skill({ name: 'wsl-skill' })])
    const discover = vi
      .fn<
        (target?: {
          runtime?: 'host' | 'wsl'
          wslDistro?: string | null
        }) => Promise<SkillDiscoveryResult>
      >()
      .mockResolvedValueOnce(hostResult)
      .mockResolvedValueOnce(wslResult)
    vi.stubGlobal('window', {
      api: { skills: { discover } }
    })

    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false)
    ).resolves.toBe(hostResult)
    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        runtime: 'wsl'
      })
    ).resolves.toBe(wslResult)
    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false)
    ).resolves.toBe(hostResult)

    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, { runtime: 'wsl', wslDistro: null })
  })

  it('forwards project runtime targets to skill discovery', async () => {
    const wslResult = discoveryResult([skill({ name: 'wsl-skill' })])
    const discover = vi.fn().mockResolvedValueOnce(wslResult)
    vi.stubGlobal('window', {
      api: { skills: { discover } }
    })

    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: projectWslRuntime
      })
    ).resolves.toBe(wslResult)

    expect(discover).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      projectRuntime: projectWslRuntime
    })
  })

  it('caches project host runtime separately from generic host discovery', async () => {
    const genericHostResult = discoveryResult([skill({ name: 'generic-host-skill' })])
    const projectHostResult = discoveryResult([skill({ name: 'project-host-skill' })])
    const discover = vi
      .fn()
      .mockResolvedValueOnce(genericHostResult)
      .mockResolvedValueOnce(projectHostResult)
    vi.stubGlobal('window', {
      api: { skills: { discover } }
    })

    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false)
    ).resolves.toBe(genericHostResult)
    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: projectHostRuntime
      })
    ).resolves.toBe(projectHostResult)
    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: projectHostRuntime
      })
    ).resolves.toBe(projectHostResult)

    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, {
      runtime: 'host',
      projectRuntime: projectHostRuntime
    })
  })

  it('evicts the least recently used historical runtime result', async () => {
    const discover = vi.fn().mockImplementation(() => Promise.resolve(discoveryResult()))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    for (let index = 0; index <= MAX_CACHED_SKILL_DISCOVERY_TARGETS; index += 1) {
      await _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: `repo-${index}`,
            reason: 'project-override',
            cacheKey: `runtime-${index}`
          }
        }
      })
    }

    expect(_installedAgentSkillDiscoveryInternalsForTests.cacheSizes().cached).toBe(
      MAX_CACHED_SKILL_DISCOVERY_TARGETS
    )
    await _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-0',
          reason: 'project-override',
          cacheKey: 'runtime-0'
        }
      }
    })
    expect(discover).toHaveBeenCalledTimes(MAX_CACHED_SKILL_DISCOVERY_TARGETS + 2)
  })

  it('rejects excess concurrent target scans instead of retaining unbounded work', async () => {
    const scans = Array.from({ length: MAX_PENDING_SKILL_DISCOVERY_TARGETS }, () =>
      deferred<SkillDiscoveryResult>()
    )
    const discover = vi.fn().mockImplementation(() => scans[discover.mock.calls.length - 1].promise)
    vi.stubGlobal('window', { api: { skills: { discover } } })
    const pending = scans.map((_, index) =>
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: `repo-${index}`,
            reason: 'project-override',
            cacheKey: `pending-${index}`
          }
        }
      })
    )

    await expect(
      _installedAgentSkillDiscoveryInternalsForTests.discoverInstalledAgentSkills(false, {
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'overflow',
            reason: 'project-override',
            cacheKey: 'pending-overflow'
          }
        }
      })
    ).rejects.toThrow(/Too many concurrent/)
    expect(_installedAgentSkillDiscoveryInternalsForTests.cacheSizes().pending).toBe(
      MAX_PENDING_SKILL_DISCOVERY_TARGETS
    )

    scans.forEach((scan) => scan.resolve(discoveryResult()))
    await Promise.all(pending)
  })
})

describe('InstalledSkillDiscoveryCoordinator invalidation', () => {
  it('does not let a scan started before cache invalidation repopulate stale data', async () => {
    const coordinator = new InstalledSkillDiscoveryCoordinator()
    const staleScan = deferred<SkillDiscoveryResult>()
    const staleResult = discoveryResult([])
    const freshResult = discoveryResult([skill({ name: 'fresh-skill' })])
    const run = vi.fn().mockReturnValueOnce(staleScan.promise).mockResolvedValueOnce(freshResult)

    const pending = coordinator.discover({ force: false, key: 'host', run })
    coordinator.clearCache()
    staleScan.resolve(staleResult)
    await expect(pending).resolves.toBe(staleResult)

    expect(coordinator.getCached('host')).toBeUndefined()
    await expect(coordinator.discover({ force: false, key: 'host', run })).resolves.toBe(
      freshResult
    )
    expect(run).toHaveBeenCalledTimes(2)
  })
})
