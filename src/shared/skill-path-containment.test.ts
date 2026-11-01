import { describe, expect, it } from 'vitest'
import {
  POSIX_SKILL_PATH_SEMANTICS,
  skillPathDepthBelow,
  skillPathInside,
  skillPathsEqual,
  WINDOWS_SKILL_PATH_SEMANTICS
} from './skill-path-containment'

describe('skillPathInside', () => {
  it('refuses the root itself, so a delete can never target a discovery root', () => {
    expect(
      skillPathInside(
        '/home/u/.claude/skills',
        '/home/u/.claude/skills',
        POSIX_SKILL_PATH_SEMANTICS
      )
    ).toBe(false)
  })

  it('refuses a `..` escape', () => {
    expect(
      skillPathInside(
        '/home/u/.claude/skills',
        '/home/u/.claude/skills/../other',
        POSIX_SKILL_PATH_SEMANTICS
      )
    ).toBe(false)
    expect(
      skillPathInside('/home/u/.claude/skills', '/home/u/other', POSIX_SKILL_PATH_SEMANTICS)
    ).toBe(false)
  })

  it('accepts a child', () => {
    expect(
      skillPathInside(
        '/home/u/.claude/skills',
        '/home/u/.claude/skills/foo',
        POSIX_SKILL_PATH_SEMANTICS
      )
    ).toBe(true)
  })

  it('keeps POSIX case-sensitive even when the process is win32', () => {
    // A WSL runtime is POSIX whatever `process.platform` says.
    expect(
      skillPathInside('/home/u/Skills', '/home/u/skills/foo', POSIX_SKILL_PATH_SEMANTICS)
    ).toBe(false)
    expect(skillPathsEqual('/a/B', '/a/b', POSIX_SKILL_PATH_SEMANTICS)).toBe(false)
  })

  it('folds case for Windows semantics', () => {
    expect(
      skillPathInside(
        'C:\\Users\\u\\.claude\\skills',
        'c:\\users\\U\\.claude\\skills\\foo',
        WINDOWS_SKILL_PATH_SEMANTICS
      )
    ).toBe(true)
    expect(skillPathsEqual('C:\\A', 'c:\\a', WINDOWS_SKILL_PATH_SEMANTICS)).toBe(true)
  })

  it('does not treat a `..`-prefixed name as a traversal', () => {
    expect(skillPathInside('/root', '/root/..cache', POSIX_SKILL_PATH_SEMANTICS)).toBe(true)
  })
})

describe('skillPathDepthBelow', () => {
  it('counts segments and returns null outside the root', () => {
    expect(skillPathDepthBelow('/r', '/r/a/SKILL.md', POSIX_SKILL_PATH_SEMANTICS)).toBe(2)
    expect(skillPathDepthBelow('/r', '/r/a/b/c/d/SKILL.md', POSIX_SKILL_PATH_SEMANTICS)).toBe(5)
    expect(skillPathDepthBelow('/r', '/other/SKILL.md', POSIX_SKILL_PATH_SEMANTICS)).toBeNull()
  })
})
