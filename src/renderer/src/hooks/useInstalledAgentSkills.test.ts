import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../shared/skills'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  _installedAgentSkillDiscoveryInternalsForTests,
  hasInstalledAgentSkill
} from './useInstalledAgentSkills'

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
})
