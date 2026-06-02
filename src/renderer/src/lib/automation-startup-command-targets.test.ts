import { describe, expect, it } from 'vitest'
import type { TerminalTab, Worktree } from '../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  getStartupCommandTitle,
  resolveGlobalStartupCommandTarget,
  resolveTrustedGlobalStartupCommandCwd,
  resolveTerminalCommandLaunchTarget,
  resolveStartupCommandTargets
} from './automation-startup-command-targets'

const makeWorktree = (overrides: Partial<Worktree>): Worktree => ({
  id: 'repo-1::/repo',
  repoId: 'repo-1',
  path: '/repo',
  displayName: 'main',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  head: 'abc',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  ...overrides
})

const makeTab = (overrides: Partial<TerminalTab>): TerminalTab => ({
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'repo-1::/repo',
  title: 'Terminal 1',
  defaultTitle: 'Terminal 1',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

describe('resolveStartupCommandTargets', () => {
  it('targets the main worktree and open project worktrees without duplicates', () => {
    const main = makeWorktree({ id: 'repo-1::/repo', path: '/repo', isMainWorktree: true })
    const openFeature = makeWorktree({
      id: 'repo-1::/repo-feature',
      path: '/repo-feature',
      displayName: 'feature',
      isMainWorktree: false
    })
    const closedFeature = makeWorktree({
      id: 'repo-1::/repo-closed',
      path: '/repo-closed',
      displayName: 'closed',
      isMainWorktree: false
    })

    const targets = resolveStartupCommandTargets({
      projectId: 'repo-1',
      launchTarget: 'main_and_open_worktrees',
      worktrees: [closedFeature, openFeature, main],
      tabsByWorktree: { [openFeature.id]: [makeTab({ worktreeId: openFeature.id })] }
    })

    expect(targets.map((worktree) => worktree.id)).toEqual([main.id, openFeature.id])
  })

  it('filters out worktrees that already have the startup command tab', () => {
    const main = makeWorktree({ id: 'repo-1::/repo', path: '/repo', isMainWorktree: true })

    const targets = resolveStartupCommandTargets({
      projectId: 'repo-1',
      launchTarget: 'main',
      worktrees: [main],
      tabsByWorktree: {
        [main.id]: [
          makeTab({
            worktreeId: main.id,
            customTitle: getStartupCommandTitle('Start dev server')
          })
        ]
      },
      duplicateTitle: getStartupCommandTitle('Start dev server')
    })

    expect(targets).toEqual([])
  })
})

describe('resolveGlobalStartupCommandTarget', () => {
  it('targets the floating workspace with the configured cwd', () => {
    expect(
      resolveGlobalStartupCommandTarget({
        globalCwd: '/Users/me/agentmemory',
        tabsByWorktree: {},
        duplicateTitle: getStartupCommandTitle('Start agentmemory')
      })
    ).toEqual({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      displayName: 'Global',
      cwd: '/Users/me/agentmemory'
    })
  })

  it('skips global startup commands without a cwd or with an existing startup tab', () => {
    expect(
      resolveGlobalStartupCommandTarget({
        globalCwd: '   ',
        tabsByWorktree: {},
        duplicateTitle: getStartupCommandTitle('Start agentmemory')
      })
    ).toBeNull()

    expect(
      resolveGlobalStartupCommandTarget({
        globalCwd: '/Users/me/agentmemory',
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            makeTab({
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              customTitle: getStartupCommandTitle('Start agentmemory')
            })
          ]
        },
        duplicateTitle: getStartupCommandTitle('Start agentmemory')
      })
    ).toBeNull()
  })
})

describe('resolveTrustedGlobalStartupCommandCwd', () => {
  it('rejects fallback directories that do not match the configured cwd', () => {
    expect(
      resolveTrustedGlobalStartupCommandCwd({
        configuredCwd: '/Users/me/agentmemory',
        resolvedCwd: '/Users/me/Library/Application Support/Orca/floating-workspace'
      })
    ).toBeNull()
  })
})

describe('resolveTerminalCommandLaunchTarget', () => {
  it('uses configured launch fanout for Run Now on an app-launch automation', () => {
    expect(
      resolveTerminalCommandLaunchTarget({
        runTrigger: 'manual',
        automationTrigger: 'app_launch',
        automationLaunchTarget: 'main_and_open_worktrees'
      })
    ).toBe('main_and_open_worktrees')
  })

  it('keeps scheduled terminal command Run Now scoped to the selected worktree', () => {
    expect(
      resolveTerminalCommandLaunchTarget({
        runTrigger: 'manual',
        automationTrigger: 'schedule',
        automationLaunchTarget: 'main_and_open_worktrees'
      })
    ).toBe('selected_worktree')
  })
})
