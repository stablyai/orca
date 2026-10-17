import { describe, expect, it } from 'vitest'
import {
  connectableLoopbackHost,
  getLocalhostWorktreeHostLabel,
  getLocalhostWorktreeRouteKey,
  slugifyLocalhostWorktreeLabel
} from './localhost-worktree-labels'

describe('localhost worktree labels', () => {
  it('uses project-main for the primary worktree', () => {
    expect(
      getLocalhostWorktreeHostLabel({
        projectName: 'Snap Studio',
        worktreeName: 'main'
      })
    ).toBe('snap-studio-main')
  })

  it('keeps non-main worktree labels short', () => {
    expect(
      getLocalhostWorktreeHostLabel({
        projectName: 'Snap Studio',
        worktreeName: 'analytics'
      })
    ).toBe('analytics')
  })

  it('uses the worktree folder name over branch owner prefixes for non-main labels', () => {
    expect(
      getLocalhostWorktreeHostLabel({
        projectName: 'Snap Studio',
        worktreeName: 'gatsby74/table-summary',
        worktreePath: '/Users/example/orca/workspaces/snapstudio/ui-auth'
      })
    ).toBe('ui-auth')
  })

  it('unbrackets an IPv6-loopback literal so net/http can connect to it', () => {
    // Why: URL.hostname yields '[::1]' for IPv6 loopback; net.connect/http.request
    // treat the bracketed form as a DNS name (ENOTFOUND). The connect target must
    // be the bare '::1'.
    expect(connectableLoopbackHost('[::1]')).toBe('::1')
  })

  it('normalizes wildcard bind hosts to connectable loopback', () => {
    expect(connectableLoopbackHost('0.0.0.0')).toBe('127.0.0.1')
    expect(connectableLoopbackHost('::')).toBe('::1')
  })

  it('normalizes labels for localhost hostnames', () => {
    expect(slugifyLocalhostWorktreeLabel(' Drive DB Mismatch! ')).toBe('drive-db-mismatch')
  })

  it('keeps route keys unique for different ports in the same worktree', () => {
    const route = {
      projectName: 'Snap Studio',
      worktreeName: 'analytics',
      repoId: 'repo-1',
      worktreeId: 'wt-analytics'
    }

    expect(
      getLocalhostWorktreeRouteKey({
        ...route,
        targetUrl: 'http://localhost:5173/'
      })
    ).not.toBe(
      getLocalhostWorktreeRouteKey({
        ...route,
        targetUrl: 'http://localhost:7777/'
      })
    )
  })
})
