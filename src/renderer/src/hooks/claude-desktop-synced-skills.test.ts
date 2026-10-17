import { describe, expect, it } from 'vitest'
import { isClaudeDesktopSyncedSkill } from './claude-desktop-synced-skills'

describe('isClaudeDesktopSyncedSkill', () => {
  it('flags a skill the Claude desktop app synced below the Claude home', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/synced/org_bucket/computer-use'
      })
    ).toBe(true)
  })

  it('flags a synced copy reached through another home root', () => {
    // `~/.claude/skills` symlinked to `~/.agents/skills` reports the same file from that root.
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: '/Users/test/.agents/skills',
        directoryPath: '/Users/test/.agents/skills/synced/org_bucket/computer-use'
      })
    ).toBe(true)
  })

  it('flags Windows synced paths regardless of separators', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: 'C:\\Users\\test\\.claude\\skills\\',
        directoryPath: 'C:\\Users\\test\\.claude\\skills\\synced\\org_bucket\\computer-use'
      })
    ).toBe(true)
  })

  it('accepts a skill installed at <root>/<name>', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/computer-use'
      })
    ).toBe(false)
  })

  it('accepts Hermes category installs', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: '/Users/test/.hermes/skills',
        directoryPath: '/Users/test/.hermes/skills/tools/computer-use'
      })
    ).toBe(false)
  })

  it('accepts a skill inside a category that is itself named `synced`', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'home',
        rootPath: '/Users/test/.hermes/skills',
        directoryPath: '/Users/test/.hermes/skills/synced/computer-use'
      })
    ).toBe(false)
  })

  it('leaves non-home skills to their own source rules', () => {
    expect(
      isClaudeDesktopSyncedSkill({
        sourceKind: 'plugin',
        rootPath: '/Users/test/.codex/plugins/cache',
        directoryPath: '/Users/test/.codex/plugins/cache/synced/vendor/orca-cli'
      })
    ).toBe(false)
  })
})
