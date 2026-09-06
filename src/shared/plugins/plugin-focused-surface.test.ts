import { describe, expect, it } from 'vitest'
import {
  PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES,
  PluginOpaqueJoinKeyMap,
  pluginFocusedSurfaceSchema,
  pluginJoinIdLooksPathBearing,
  pluginUiFocusChangedPayloadSchema,
  projectPluginFocusJoinId,
  projectPluginFocusedTitle,
  projectPluginUiFocusReport,
  pluginFocusedSurfacesEqual
} from './plugin-focused-surface'

describe('projectPluginFocusedTitle', () => {
  it('returns null for empty or whitespace titles', () => {
    expect(projectPluginFocusedTitle(null)).toBeNull()
    expect(projectPluginFocusedTitle('')).toBeNull()
    expect(projectPluginFocusedTitle('   ')).toBeNull()
  })

  it('keeps a short tab label', () => {
    expect(projectPluginFocusedTitle('Terminal 1')).toBe('Terminal 1')
  })

  it('projects path-like titles to a basename', () => {
    expect(projectPluginFocusedTitle('/Users/private/repo/src/main.ts')).toBe('main.ts')
    expect(projectPluginFocusedTitle('C:\\Users\\private\\repo\\README.md')).toBe('README.md')
  })

  it('projects http(s) titles to a hostname', () => {
    expect(projectPluginFocusedTitle('https://example.com/secret/path?token=1')).toBe('example.com')
  })

  it('truncates to the privacy byte budget', () => {
    const title = 'a'.repeat(PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES + 20)
    const projected = projectPluginFocusedTitle(title)
    expect(projected).toHaveLength(PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES)
  })
})

describe('projectPluginUiFocusReport', () => {
  it('returns null when the window is unfocused or kind is missing', () => {
    expect(projectPluginUiFocusReport({ windowFocused: false, kind: 'terminal' })).toBeNull()
    expect(projectPluginUiFocusReport({ windowFocused: true })).toBeNull()
    expect(projectPluginUiFocusReport({ unexpected: true })).toBeNull()
  })

  it('projects a focused surface and sanitizes the title', () => {
    expect(
      projectPluginUiFocusReport({
        windowFocused: true,
        kind: 'editor',
        title: '/tmp/identifying/file.ts'
      })
    ).toEqual({ kind: 'editor', title: 'file.ts' })
  })

  it('omits path-bearing worktree ids when no session map is provided', () => {
    expect(
      projectPluginUiFocusReport({
        windowFocused: true,
        kind: 'terminal',
        title: 'zsh',
        worktreeId: 'repo-1::/Users/private/orca'
      })
    ).toEqual({
      kind: 'terminal',
      title: 'zsh'
    })
  })

  it('maps path-bearing worktree ids to a stable session token', () => {
    const joinKeys = new PluginOpaqueJoinKeyMap()
    const report = {
      windowFocused: true as const,
      kind: 'terminal' as const,
      title: 'zsh',
      worktreeId: 'repo-1::/Users/private/orca'
    }
    const first = projectPluginUiFocusReport(report, joinKeys)
    const second = projectPluginUiFocusReport(report, joinKeys)
    expect(first?.worktreeId).toMatch(/^pj_[a-z0-9]+$/)
    expect(first?.worktreeId).toBe(second?.worktreeId)
    expect(first?.worktreeId).not.toContain('/')
    expect(first?.worktreeId).not.toContain('::')
    expect(
      projectPluginUiFocusReport(
        { ...report, worktreeId: 'repo-2::/Users/private/other' },
        joinKeys
      )?.worktreeId
    ).not.toBe(first?.worktreeId)
  })

  it('includes agentId only for agent surfaces', () => {
    expect(
      projectPluginUiFocusReport({
        windowFocused: true,
        kind: 'agent',
        title: 'Claude',
        worktreeId: 'wt-1',
        agentId: 'tab-agent-1'
      })
    ).toEqual({
      kind: 'agent',
      title: 'Claude',
      worktreeId: 'wt-1',
      agentId: 'tab-agent-1'
    })
    expect(
      projectPluginUiFocusReport({
        windowFocused: true,
        kind: 'terminal',
        title: 'zsh',
        worktreeId: 'wt-1',
        agentId: 'tab-agent-1'
      })
    ).toEqual({
      kind: 'terminal',
      title: 'zsh',
      worktreeId: 'wt-1'
    })
  })
})

describe('plugin focus schemas', () => {
  it('rejects extra keys and oversize titles on the public projection', () => {
    expect(
      pluginFocusedSurfaceSchema.safeParse({
        kind: 'terminal',
        title: 'ok',
        path: '/secret'
      }).success
    ).toBe(false)
    expect(
      pluginUiFocusChangedPayloadSchema.safeParse({
        focusedSurface: { kind: 'agent', title: null },
        receivedAt: Date.now(),
        worktreeId: '/Users/private/repo'
      }).success
    ).toBe(false)
    expect(
      pluginFocusedSurfaceSchema.safeParse({
        kind: 'agent',
        title: 'Claude',
        worktreeId: 'pj_1',
        agentId: 'tab-agent-1'
      }).success
    ).toBe(true)
  })
})

describe('pluginJoinIdLooksPathBearing', () => {
  it('detects repoId::path and slash-bearing ids', () => {
    expect(pluginJoinIdLooksPathBearing('repo-1::/Users/private/orca')).toBe(true)
    expect(pluginJoinIdLooksPathBearing('repo-1::C:\\Users\\private\\orca')).toBe(true)
    expect(pluginJoinIdLooksPathBearing('/Users/private/repo')).toBe(true)
    expect(pluginJoinIdLooksPathBearing('wt-1')).toBe(false)
    expect(pluginJoinIdLooksPathBearing('tab-agent-1')).toBe(false)
  })
})

describe('projectPluginFocusJoinId', () => {
  it('passes through non-path ids and tokenizes path-bearing ids only with a map', () => {
    expect(projectPluginFocusJoinId('wt-1')).toBe('wt-1')
    expect(projectPluginFocusJoinId('repo-1::/Users/private/orca')).toBeNull()
    const joinKeys = new PluginOpaqueJoinKeyMap()
    expect(projectPluginFocusJoinId('repo-1::/Users/private/orca', joinKeys)).toBe('pj_1')
    expect(projectPluginFocusJoinId('repo-1::/Users/private/orca', joinKeys)).toBe('pj_1')
  })
})

describe('pluginFocusedSurfacesEqual', () => {
  it('treats identical projections as unchanged', () => {
    const surface = { kind: 'browser' as const, title: 'example.com' }
    expect(pluginFocusedSurfacesEqual(surface, { ...surface })).toBe(true)
    expect(pluginFocusedSurfacesEqual(surface, { kind: 'browser', title: 'other.com' })).toBe(false)
    expect(pluginFocusedSurfacesEqual(null, null)).toBe(true)
    expect(
      pluginFocusedSurfacesEqual(
        { kind: 'agent', title: 'Claude', worktreeId: 'wt-1', agentId: 'a' },
        { kind: 'agent', title: 'Claude', worktreeId: 'wt-1', agentId: 'b' }
      )
    ).toBe(false)
  })
})
