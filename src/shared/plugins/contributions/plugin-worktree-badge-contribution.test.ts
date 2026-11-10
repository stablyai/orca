import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

function manifest(
  badge: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  badgeCount = 1
): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'engine',
    name: 'Engine',
    version: '1.0.0',
    engines: { orca: '>=1.4.256' },
    main: 'main.mjs',
    contributes: {
      commands: [
        { id: 'open-project', title: 'Open project', when: 'workspace' },
        { id: 'refresh', title: 'Refresh' },
        { id: 'tasks', title: 'Tasks', action: 'view.tasks', when: 'workspace' }
      ],
      worktreeBadges: Array.from({ length: badgeCount }, () => ({
        id: 'engine-project',
        title: 'Engine project',
        icon: 'icons/engine.svg',
        when: { pathExists: ['ProjectSettings/ProjectVersion.txt'] },
        commands: ['open-project'],
        ...badge
      }))
    },
    capabilities: [{ kind: 'workspace:read' }],
    ...overrides
  }
}

/** The manifest's parse error, or `''` when it parses. */
function issues(raw: unknown): string {
  const parsed = parsePluginManifest(raw)
  return parsed.ok ? '' : parsed.error
}

describe('contributes.worktreeBadges', () => {
  it('accepts an SVG or a panel icon name and defaults to any host and the workspace folder', () => {
    const svg = parsePluginManifest(manifest({}))
    expect(svg.ok && svg.manifest.contributes.worktreeBadges[0]?.when).toMatchObject({
      host: 'any',
      searchDepth: 0
    })
    expect(issues(manifest({ icon: 'package', when: { pathExists: ['a'], host: 'local' } }))).toBe(
      ''
    )
  })

  it('refuses icons that are neither a known name nor a portable SVG path', () => {
    expect(issues(manifest({ icon: 'gamepad-2' }))).toContain('worktreeBadges[0].icon')
    expect(issues(manifest({ icon: '../outside.svg' }))).toContain('worktreeBadges[0].icon')
    expect(issues(manifest({ icon: 'icons/engine.png' }))).toContain('worktreeBadges[0].icon')
  })

  it('bounds how deep a badge searches subfolders', () => {
    const when = (searchDepth: number) => ({ pathExists: ['project.godot'], searchDepth })
    expect(issues(manifest({ when: when(3) }))).toBe('')
    expect(issues(manifest({ when: when(4) }))).toContain('worktreeBadges[0].when.searchDepth')
  })

  it('refuses marker paths that leave the workspace folder', () => {
    expect(issues(manifest({ when: { pathExists: ['../ProjectVersion.txt'] } }))).toContain(
      'worktreeBadges[0].when.pathExists[0]'
    )
  })

  it('offers only worker commands that run on a workspace', () => {
    for (const command of ['missing', 'refresh', 'tasks']) {
      expect(issues(manifest({ commands: [command] }))).toContain(
        `must name a contributed worker command with when "workspace": ${command}`
      )
    }
  })

  it('needs workspace:read, since its commands receive the folder', () => {
    expect(issues(manifest({}, { capabilities: [] }))).toContain('"workspace:read" capability')
  })

  it('refuses duplicate badge ids', () => {
    expect(issues(manifest({}, {}, 2))).toContain('duplicate worktreeBadges id: engine-project')
  })

  it('raises the engine floor to the release that reads badges', () => {
    expect(issues(manifest({}, { engines: { orca: '>=1.4.255' } }))).toContain(
      'contributes.worktreeBadges'
    )
  })
})
