import { describe, expect, it } from 'vitest'
import type { FeatureWallSetupProgressInput } from './feature-wall-setup-progress'
import { getFeatureWallSetupProgress } from './feature-wall-setup-progress'
import {
  getFeatureWallSetupSteps,
  getFeatureWallSetupStepsForSection,
  getFirstIncompleteFeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { Worktree } from '../../../../shared/types'

function makeInput(
  overrides: Partial<FeatureWallSetupProgressInput> = {}
): FeatureWallSetupProgressInput {
  return {
    settings: null,
    featureInteractions: {},
    hasConnectedTaskSource: false,
    browserUseSkillInstalled: false,
    computerUseSkillInstalled: false,
    computerUsePermissionsReady: false,
    orchestrationSkillInstalled: false,
    gitRepoCount: 0,
    worktreesByRepo: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    hasSetupScript: false,
    ...overrides
  }
}

function makeWorktree(
  id: string,
  options: { createdAt?: number; isMainWorktree?: boolean; path?: string | null } = {}
): Worktree {
  return {
    id,
    path: options.path === null ? undefined : (options.path ?? `/repo/${id}`),
    createdAt: options.createdAt,
    isMainWorktree: options.isMainWorktree ?? false
  } as unknown as Worktree
}

function makeSplitLayout(): FeatureWallSetupProgressInput['terminalLayoutsByTabId'][string] {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-1' },
      second: { type: 'leaf', leafId: 'leaf-2' }
    }
  } as never
}

function makeLeafLayout(): FeatureWallSetupProgressInput['terminalLayoutsByTabId'][string] {
  return { root: { type: 'leaf', leafId: 'leaf-1' } } as never
}

describe('getFeatureWallSetupProgress', () => {
  it('tracks Add 2 projects from durable git repo count', () => {
    expect(getFeatureWallSetupProgress(makeInput({ gitRepoCount: 1 })).stepDone).toMatchObject({
      'add-two-repos': false
    })

    const progress = getFeatureWallSetupProgress(makeInput({ gitRepoCount: 2 }))

    expect(progress.stepDone['add-two-repos']).toBe(true)
    expect(progress.coreTotal).toBe(8)
  })

  it('orders visible parallel work before setup tasks', () => {
    expect(getFeatureWallSetupSteps().map((step) => step.id)).toEqual([
      'split-terminal',
      'two-worktrees',
      'notifications',
      'default-agent',
      'agent-capabilities',
      'task-sources',
      'setup-script',
      'add-two-repos'
    ])
  })

  it('groups setup guide steps into Parallel work and Setup sections', () => {
    expect(getFeatureWallSetupStepsForSection('parallel-work').map((step) => step.id)).toEqual([
      'split-terminal',
      'two-worktrees'
    ])
    expect(getFeatureWallSetupStepsForSection('setup').map((step) => step.id)).toEqual([
      'notifications',
      'default-agent',
      'agent-capabilities',
      'task-sources',
      'setup-script',
      'add-two-repos'
    ])
  })

  it('auto-selects incomplete parallel work before setup steps', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        settings: {
          defaultTuiAgent: 'claude',
          notifications: { enabled: true, agentTaskComplete: true }
        } as never,
        hasConnectedTaskSource: true,
        hasSetupScript: true,
        gitRepoCount: 2,
        browserUseSkillInstalled: true,
        computerUseSkillInstalled: true,
        computerUsePermissionsReady: true,
        orchestrationSkillInstalled: true
      })
    )

    expect(getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)).toBe('split-terminal')
  })

  it('marks the step complete from durable terminal-pane split interaction state', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-pane-split': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 }
        }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(true)
  })

  it('does not mark the step complete from malformed durable terminal-pane split state', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-pane-split': { firstInteractedAt: Number.NaN, interactionCount: 1 }
        }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(false)
  })

  it('does not mark the step complete from generic pane interaction state', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-panes': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 }
        }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(false)
  })

  it('does not mark the step complete when a worktree tab has only a single pane', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] },
        tabsByWorktree: {
          'worktree-1': [{ id: 'tab-1', title: 'Terminal' }] as never
        },
        terminalLayoutsByTabId: { 'tab-1': makeLeafLayout() }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(false)
  })

  it('does not mark the step complete from a live split layout without durable state', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] },
        tabsByWorktree: {
          'worktree-1': [{ id: 'tab-1', title: 'Terminal' }] as never
        },
        terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(false)
  })

  it('keeps the step complete after the split tab closes from durable state', () => {
    const withSplit = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-pane-split': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 }
        },
        worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] },
        tabsByWorktree: {
          'worktree-1': [{ id: 'tab-1', title: 'Terminal' }] as never
        },
        terminalLayoutsByTabId: { 'tab-1': makeSplitLayout() }
      })
    )

    expect(withSplit.stepDone['split-terminal']).toBe(true)

    const afterClosingSplitTab = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'terminal-pane-split': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 }
        },
        worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] },
        tabsByWorktree: { 'worktree-1': [] },
        terminalLayoutsByTabId: {}
      })
    )

    expect(afterClosingSplitTab.stepDone['split-terminal']).toBe(true)
  })

  it('ignores split layouts for tabs that do not belong to a known worktree', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: { 'repo-1': [makeWorktree('worktree-1')] },
        tabsByWorktree: {
          'worktree-1': [{ id: 'tab-1', title: 'Terminal' }] as never
        },
        terminalLayoutsByTabId: { 'orphan-tab': makeSplitLayout() }
      })
    )

    expect(progress.stepDone['split-terminal']).toBe(false)
  })

  it('does not mark the step complete from the main checkout alone', () => {
    expect(
      getFeatureWallSetupProgress(
        makeInput({
          worktreesByRepo: { 'repo-1': [makeWorktree('main', { isMainWorktree: true })] }
        })
      ).stepDone['two-worktrees']
    ).toBe(false)
  })

  it('does not pre-complete the step when two repos contribute only main checkouts', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: {
          'repo-1': [makeWorktree('main-1', { isMainWorktree: true })],
          'repo-2': [makeWorktree('main-2', { isMainWorktree: true })]
        }
      })
    )

    expect(progress.stepDone['two-worktrees']).toBe(false)
  })

  it('does not mark the step complete from an unconfirmed non-main worktree placeholder', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('main', { isMainWorktree: true }),
            makeWorktree('ssh-restored-placeholder', { path: null })
          ]
        }
      })
    )

    expect(progress.stepDone['two-worktrees']).toBe(false)
  })

  it('marks the step complete once a non-main worktree exists beyond the main checkout', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        worktreesByRepo: {
          'repo-1': [makeWorktree('main', { isMainWorktree: true }), makeWorktree('worktree-1')]
        }
      })
    )

    expect(progress.stepDone['two-worktrees']).toBe(true)
  })

  it('marks task sources complete for any supported connected provider', () => {
    const progress = getFeatureWallSetupProgress(makeInput({ hasConnectedTaskSource: true }))

    expect(progress.stepDone['task-sources']).toBe(true)
  })

  it('does not mark agent capabilities complete from setup-start interactions alone', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        featureInteractions: {
          'agent-browser-setup': { firstInteractedAt: 1_700_000_000_000, interactionCount: 1 },
          'computer-use-setup': { firstInteractedAt: 1_700_000_000_001, interactionCount: 1 },
          'agent-orchestration-setup': {
            firstInteractedAt: 1_700_000_000_002,
            interactionCount: 1
          }
        }
      })
    )

    expect(progress.stepDone['agent-capabilities']).toBe(false)
  })

  it('marks agent capabilities complete only when required skills and permissions are ready', () => {
    expect(
      getFeatureWallSetupProgress(
        makeInput({
          browserUseSkillInstalled: true,
          computerUseSkillInstalled: true,
          computerUsePermissionsReady: false,
          orchestrationSkillInstalled: true
        })
      ).stepDone['agent-capabilities']
    ).toBe(false)

    const progress = getFeatureWallSetupProgress(
      makeInput({
        browserUseSkillInstalled: true,
        computerUseSkillInstalled: true,
        computerUsePermissionsReady: true,
        orchestrationSkillInstalled: true
      })
    )

    expect(progress.stepDone['agent-capabilities']).toBe(true)
  })

  it('does not block agent capabilities on unavailable Computer Use access', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        browserUseSkillInstalled: true,
        computerUseSkillInstalled: true,
        computerUsePermissionsReady: false,
        computerUseUnavailable: true,
        orchestrationSkillInstalled: true
      })
    )

    expect(progress.stepDone['agent-capabilities']).toBe(true)
  })

  it('marks the Orca CLI setup row complete when installed skills are ready and Computer Use is unavailable', () => {
    const progress = getFeatureWallSetupProgress(
      makeInput({
        browserUseSkillInstalled: true,
        computerUseSkillInstalled: true,
        computerUsePermissionsReady: false,
        computerUseUnavailable: true,
        orchestrationSkillInstalled: true
      })
    )

    expect(progress.stepDone).toMatchObject({
      'agent-capabilities': true
    })
    expect(getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)).not.toBe(
      'agent-capabilities'
    )
  })
})
