import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { skillAgentOptions, skillMatchesAgent } from './skill-agent-filter'

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'id',
    name: 'Review',
    description: 'Code review',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/a',
    directoryPath: '/a/review',
    skillFilePath: '/a/review/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

/** Pre-change implementation, kept verbatim as the parity oracle. */
function legacySkillMatchesAgent(
  target: DiscoveredSkill,
  agentId: string,
  agentByRootPath: ReadonlyMap<string, string>
): boolean {
  const agents = (): string[] => {
    const roots = target.rootPaths?.length ? target.rootPaths : [target.rootPath]
    return [...new Set(roots.map((root) => agentByRootPath.get(root)).filter(Boolean))] as string[]
  }
  return agentId === 'all' || agents().includes(agentId)
}

/** Counts ownership lookups so the before/after difference is deterministic. */
class LookupCountingMap extends Map<string, string> {
  lookups = 0
  override get(key: string): string | undefined {
    this.lookups += 1
    return super.get(key)
  }
}

const WINDOWS_ROOT = 'C:\\Users\\dev\\.agents\\skills'
const OPAQUE_REMOTE_ROOT = 'orca-ssh://build-box/srv/shared/.agents/skills'

const OWNERS_WITH_EMPTY: [string, string][] = [
  ['/a', 'claude'],
  ['/b', 'codex'],
  ['/c', 'codex'],
  ['/empty', ''],
  [WINDOWS_ROOT, 'shared'],
  [OPAQUE_REMOTE_ROOT, 'claude']
]
const OWNERS_WITHOUT_EMPTY: [string, string][] = OWNERS_WITH_EMPTY.filter(
  ([, owner]) => owner !== ''
).map(([root, owner]) => (root === '/a' ? [root, 'shared'] : [root, owner]))

describe('skillMatchesAgent', () => {
  it('matches the legacy agent list across sparse, repeated, and opaque roots', () => {
    const rootPathsCases: (string[] | undefined)[] = [
      undefined,
      [],
      ['/a'],
      ['/a', '/a'],
      ['/a', '/b'],
      ['/b', '/a'],
      ['/missing'],
      ['/a', '/missing'],
      ['/empty'],
      ['/a', '/empty'],
      [WINDOWS_ROOT],
      [OPAQUE_REMOTE_ROOT]
    ]
    const rootPathCases = ['/a', '/missing', '/empty', WINDOWS_ROOT, OPAQUE_REMOTE_ROOT]
    const agentIds = ['all', 'claude', 'codex', 'shared', '', 'unknown']
    const maps = [new Map(OWNERS_WITH_EMPTY), new Map(OWNERS_WITHOUT_EMPTY)]

    let cases = 0
    for (const rootPaths of rootPathsCases) {
      for (const rootPath of rootPathCases) {
        for (const agentId of agentIds) {
          for (const agentByRootPath of maps) {
            const row = skill({ rootPath, rootPaths })
            expect({
              rootPaths,
              rootPath,
              agentId,
              matched: skillMatchesAgent(row, agentId, agentByRootPath)
            }).toEqual({
              rootPaths,
              rootPath,
              agentId,
              matched: legacySkillMatchesAgent(row, agentId, agentByRootPath)
            })
            cases += 1
          }
        }
      }
    }
    expect(cases).toBe(720)
  })

  it('treats populated rootPaths as authoritative instead of unioning rootPath', () => {
    const agentByRootPath = new Map(OWNERS_WITH_EMPTY)
    const row = skill({ rootPath: '/a', rootPaths: ['/b'] })
    expect(skillMatchesAgent(row, 'claude', agentByRootPath)).toBe(false)
    expect(skillMatchesAgent(row, 'codex', agentByRootPath)).toBe(true)
  })

  it('falls back to rootPath only when rootPaths is absent or empty', () => {
    const agentByRootPath = new Map(OWNERS_WITH_EMPTY)
    expect(skillMatchesAgent(skill({ rootPaths: undefined }), 'claude', agentByRootPath)).toBe(true)
    expect(skillMatchesAgent(skill({ rootPaths: [] }), 'claude', agentByRootPath)).toBe(true)
  })

  it('never lets an empty owner become a filter', () => {
    const agentByRootPath = new Map(OWNERS_WITH_EMPTY)
    expect(skillMatchesAgent(skill({ rootPath: '/empty' }), '', agentByRootPath)).toBe(false)
    expect(skillMatchesAgent(skill({ rootPaths: ['/empty'] }), '', agentByRootPath)).toBe(false)
    expect(skillMatchesAgent(skill({ rootPath: '/a' }), '', agentByRootPath)).toBe(false)
  })

  it('keeps "all" a success before any ownership lookup', () => {
    const agentByRootPath = new LookupCountingMap(OWNERS_WITH_EMPTY)
    expect(
      skillMatchesAgent(skill({ rootPaths: ['/a', '/b', '/c'] }), 'all', agentByRootPath)
    ).toBe(true)
    expect(agentByRootPath.lookups).toBe(0)
  })

  it('cuts ownership lookups from 30,000 to 10,000 for 10,000 three-root rows', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      skill({ id: `skill-${index}`, rootPaths: ['/a', '/b', '/c'] })
    )
    const before = new LookupCountingMap(OWNERS_WITH_EMPTY)
    const after = new LookupCountingMap(OWNERS_WITH_EMPTY)

    const legacyMatches = rows.map((row) => legacySkillMatchesAgent(row, 'claude', before))
    const matches = rows.map((row) => skillMatchesAgent(row, 'claude', after))

    expect(matches).toEqual(legacyMatches)
    expect(matches.every(Boolean)).toBe(true)
    expect(before.lookups).toBe(30_000)
    expect(after.lookups).toBe(10_000)
  })

  it('still scans every root when none of them owns the filtered agent', () => {
    const agentByRootPath = new LookupCountingMap(OWNERS_WITH_EMPTY)
    expect(
      skillMatchesAgent(skill({ rootPaths: ['/a', '/b', '/c'] }), 'unknown', agentByRootPath)
    ).toBe(false)
    expect(agentByRootPath.lookups).toBe(3)
  })
})

describe('skillAgentOptions', () => {
  it('still counts every owning root once per skill', () => {
    const options = skillAgentOptions({
      scannedAt: 1,
      sources: [
        {
          id: 'a',
          label: 'A',
          path: '/a',
          sourceKind: 'home',
          providers: [],
          owner: 'claude',
          exists: true
        },
        {
          id: 'b',
          label: 'B',
          path: '/b',
          sourceKind: 'repo',
          providers: [],
          owner: 'codex',
          exists: true
        },
        {
          id: 'shared',
          label: 'S',
          path: '/s',
          sourceKind: 'repo',
          providers: [],
          owner: null,
          exists: true
        }
      ],
      skills: [
        skill({ id: 'one', rootPaths: ['/a', '/a', '/b'] }),
        skill({ id: 'two', rootPaths: ['/a'] }),
        skill({ id: 'three', rootPath: '/s', rootPaths: undefined }),
        skill({ id: 'four', rootPath: '/missing', rootPaths: undefined })
      ]
    })
    expect(options.map((option) => [option.id, option.count])).toEqual([
      ['claude', 2],
      ['codex', 1],
      ['shared', 1]
    ])
  })
})
