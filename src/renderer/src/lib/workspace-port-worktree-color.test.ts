import { describe, expect, it } from 'vitest'
import { getLocalhostWorktreeCssColor } from '../../../shared/localhost-worktree-color'
import { getLocalhostWorktreeHostLabel } from '../../../shared/localhost-worktree-labels'
import { localhostWorktreeColorForRoute } from './workspace-port-worktree-color'

describe('localhostWorktreeColorForRoute', () => {
  it('returns null without a route (labels disabled or non-workspace port)', () => {
    expect(localhostWorktreeColorForRoute(null)).toBeNull()
  })

  it('matches the color the proxy favicon derives for the same label', () => {
    const route = {
      targetUrl: 'http://localhost:5182/',
      projectName: 'Snap Demo',
      worktreeName: 'checkout-flow',
      worktreePath: '/repos/snapdemo/checkout-flow'
    }

    expect(localhostWorktreeColorForRoute(route)).toBe(
      getLocalhostWorktreeCssColor(getLocalhostWorktreeHostLabel(route))
    )
  })
})
