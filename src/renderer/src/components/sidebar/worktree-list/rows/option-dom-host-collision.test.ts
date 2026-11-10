// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { getMountedWorktreeCopyOptions, markSidebarWorktreeActiveImmediately } from './option-dom'

afterEach(() => {
  document.body.replaceChildren()
})

describe('immediate sidebar activation host identity', () => {
  it('marks only the clicked host copies active when workspace ids collide', () => {
    document.body.innerHTML = `
      <div data-worktree-sidebar>
        <div role="option" data-worktree-id="shared" data-worktree-host-identity="local|shared" data-worktree-row-key="pinned:local|shared"><div data-worktree-card-surface /></div>
        <div role="option" data-worktree-id="shared" data-worktree-host-identity="local|shared" data-worktree-row-key="all:local|shared"><div data-worktree-card-surface /></div>
        <div role="option" data-worktree-id="shared" data-worktree-host-identity="ssh:host-b|shared" data-worktree-row-key="all:ssh:host-b|shared"><div data-worktree-card-surface /></div>
      </div>
    `

    markSidebarWorktreeActiveImmediately('shared', 'all:ssh:host-b|shared')

    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page'
    ])
  })
})

describe('mounted worktree copy lookup', () => {
  it('returns only the requested host copy when workspace ids collide', () => {
    document.body.innerHTML = `
      <div role="option" data-worktree-id="shared" data-worktree-host-identity="|shared"></div>
      <div role="option" data-worktree-id="shared" data-worktree-host-identity="ssh:host-b|shared"></div>
    `

    const options = getMountedWorktreeCopyOptions(
      [{ id: 'shared', hostId: 'ssh:host-b' }],
      document
    )

    expect(
      [...options].map(([identity, matches]) => [
        identity,
        matches.map((option) => option.dataset.worktreeHostIdentity)
      ])
    ).toEqual([['ssh:host-b|shared', ['ssh:host-b|shared']]])
  })
})
