import { describe, expect, it } from 'vitest'

import { worktreeIdsShareCheckout } from './id'

const BASE_ID = 'folder-repo::/home/ada/notes'
const INSTANCE_A = `${BASE_ID}::workspace:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b`
const INSTANCE_B = `${BASE_ID}::workspace:9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a`

describe('worktreeIdsShareCheckout', () => {
  it('matches a folder workspace id with an instance of the same folder', () => {
    expect(worktreeIdsShareCheckout(BASE_ID, INSTANCE_A)).toBe(true)
    expect(worktreeIdsShareCheckout(INSTANCE_A, BASE_ID)).toBe(true)
  })

  it('matches two instances of one folder', () => {
    expect(worktreeIdsShareCheckout(INSTANCE_A, INSTANCE_B)).toBe(true)
  })

  it('keeps repo ids exact on a shared path', () => {
    expect(worktreeIdsShareCheckout(BASE_ID, 'other-repo::/home/ada/notes')).toBe(false)
    expect(
      worktreeIdsShareCheckout(
        INSTANCE_A,
        `other-repo::/home/ada/notes::workspace:${'0'.repeat(36)}`
      )
    ).toBe(false)
  })

  it('falls back to strict equality for malformed and folder: ids', () => {
    expect(worktreeIdsShareCheckout('folder:home-1', 'folder:home-1')).toBe(true)
    expect(worktreeIdsShareCheckout('folder:home-1', 'folder:home-2')).toBe(false)
    expect(worktreeIdsShareCheckout('folder:home-1', BASE_ID)).toBe(false)
    expect(worktreeIdsShareCheckout('repo-only', 'repo-only')).toBe(true)
    expect(worktreeIdsShareCheckout('repo-only', 'repo-other')).toBe(false)
  })

  it('folds path spelling like worktreeIdsEqual', () => {
    const left = 'repo::C:\\Users\\Ada\\Notes'
    const right = 'repo::c:/users/ada/notes/::workspace:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
    expect(worktreeIdsShareCheckout(left, right)).toBe(true)
    expect(worktreeIdsShareCheckout('repo::/home/Ada', 'repo::/home/ada')).toBe(false)
  })

  it('keeps distinct git worktrees apart', () => {
    expect(worktreeIdsShareCheckout('repo::/src/app', 'repo::/src/app-feature')).toBe(false)
  })
})
