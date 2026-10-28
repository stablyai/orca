import { describe, expect, it } from 'vitest'
import { parseWorktreeDeepLink, worktreeDeepLinkFromArguments } from './worktree-deep-link'

describe('parseWorktreeDeepLink', () => {
  it('parses orca://worktree/create with parameters', () => {
    const result = parseWorktreeDeepLink(
      'orca://worktree/create?repo=my-project&name=feat-voice&branch=main'
    )
    expect(result).toEqual({
      type: 'worktree-create',
      repo: 'my-project',
      name: 'feat-voice',
      branch: 'main'
    })
  })

  it('parses orca://worktree/new alias', () => {
    expect(parseWorktreeDeepLink('orca://worktree/new?repo=demo-engine&name=feat-omlx')).toEqual({
      type: 'worktree-create',
      repo: 'demo-engine',
      name: 'feat-omlx'
    })
  })

  it('handles triple slash orca:///worktree/create links', () => {
    expect(parseWorktreeDeepLink('orca:///worktree/create?name=scratch')).toEqual({
      type: 'worktree-create',
      name: 'scratch'
    })
  })

  it('accepts HTTPS links from approved production and localhost hosts', () => {
    expect(
      parseWorktreeDeepLink('https://app.orca.dev/worktree/create?repo=core&name=fix')
    ).toEqual({
      type: 'worktree-create',
      repo: 'core',
      name: 'fix'
    })

    expect(parseWorktreeDeepLink('https://share.onorca.dev/worktree/new?repo=my-project')).toEqual({
      type: 'worktree-create',
      repo: 'my-project'
    })

    expect(parseWorktreeDeepLink('http://localhost:5173/worktree/create?name=dev')).toEqual({
      type: 'worktree-create',
      name: 'dev'
    })
  })

  it('rejects unsafe protocols, invalid origins, and unhandled paths', () => {
    expect(parseWorktreeDeepLink('')).toBeNull()
    expect(parseWorktreeDeepLink('not-a-url')).toBeNull()
    expect(parseWorktreeDeepLink('javascript:alert(1)')).toBeNull()
    expect(parseWorktreeDeepLink('file:///etc/passwd')).toBeNull()
    expect(parseWorktreeDeepLink('https://attacker.test/worktree/create?repo=evil')).toBeNull()
    expect(parseWorktreeDeepLink('orca://orchestration/new')).toBeNull()
    expect(parseWorktreeDeepLink('orca://unknown/action')).toBeNull()
  })

  it('drops unsafe name/branch values instead of passing them through', () => {
    // Leading `-` risks flag injection once these reach a git/worktree command.
    expect(
      parseWorktreeDeepLink('orca://worktree/create?name=-x&branch=--upload-pack=evil')
    ).toEqual({ type: 'worktree-create' })
    // `..` path-traversal segments and embedded NULs are dropped too (supporting both / and \).
    expect(parseWorktreeDeepLink('orca://worktree/create?name=../../etc&branch=main')).toEqual({
      type: 'worktree-create',
      branch: 'main'
    })
    expect(parseWorktreeDeepLink('orca://worktree/create?name=..\\..\\evil&branch=main')).toEqual({
      type: 'worktree-create',
      branch: 'main'
    })
    expect(parseWorktreeDeepLink('orca://worktree/create?name=feat%00x')).toEqual({
      type: 'worktree-create'
    })
    // Ordinary slash-separated branch names remain intact.
    expect(parseWorktreeDeepLink('orca://worktree/create?name=feat/siri-shortcuts')).toEqual({
      type: 'worktree-create',
      name: 'feat/siri-shortcuts'
    })
  })
})

describe('worktreeDeepLinkFromArguments', () => {
  it('extracts matching worktree deep link from process argv array', () => {
    const argv = ['/path/to/orca', 'orca://worktree/create?repo=my-project&name=feat-1']
    expect(worktreeDeepLinkFromArguments(argv)).toEqual({
      type: 'worktree-create',
      repo: 'my-project',
      name: 'feat-1'
    })
  })

  it('returns null when no matching argument is present', () => {
    expect(worktreeDeepLinkFromArguments([])).toBeNull()
    expect(worktreeDeepLinkFromArguments(['orca', '--hidden'])).toBeNull()
    expect(worktreeDeepLinkFromArguments(['orca', 'orca://orchestration/new'])).toBeNull()
  })
})
