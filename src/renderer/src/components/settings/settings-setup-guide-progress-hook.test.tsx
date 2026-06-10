import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import { useSettingsSetupGuideProgress } from './settings-setup-guide-progress'

const mocks = vi.hoisted(() => ({
  useSetupGuideProgress: vi.fn()
}))

vi.mock('../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: mocks.useSetupGuideProgress
}))

function makeProgress(): FeatureWallSetupProgress {
  return {
    ready: true,
    stepDone: {
      'default-agent': true,
      'add-two-repos': false,
      notifications: true,
      'split-terminal': true,
      'two-worktrees': true,
      browser: false,
      'task-sources': true,
      'agent-capabilities': false,
      'setup-script': false
    },
    coreDoneCount: 5,
    coreTotal: 9
  }
}

function SettingsProgressProbe(): React.JSX.Element {
  const progress = useSettingsSetupGuideProgress(true)
  return <span>{`${progress.doneCount}/${progress.total}`}</span>
}

describe('useSettingsSetupGuideProgress', () => {
  beforeEach(() => {
    mocks.useSetupGuideProgress.mockReset()
  })

  it('uses the same setup progress path as the main sidebar', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeProgress())

    expect(renderToStaticMarkup(<SettingsProgressProbe />)).toContain('5/9')
    expect(mocks.useSetupGuideProgress).toHaveBeenCalledWith(true, false, false)
  })

  it('uses legacy-aware completion returned by the shared setup progress path', () => {
    mocks.useSetupGuideProgress.mockReturnValue({
      ...makeProgress(),
      stepDone: {
        'default-agent': true,
        'add-two-repos': true,
        notifications: true,
        'split-terminal': true,
        'two-worktrees': true,
        browser: true,
        'task-sources': true,
        'agent-capabilities': true,
        'setup-script': true
      },
      coreDoneCount: 9
    })

    expect(renderToStaticMarkup(<SettingsProgressProbe />)).toContain('9/9')
  })

  it('shows browser incomplete after the browser migration has already run for fresh users', () => {
    mocks.useSetupGuideProgress.mockReturnValue({
      ...makeProgress(),
      stepDone: {
        'default-agent': true,
        'add-two-repos': true,
        notifications: true,
        'split-terminal': true,
        'two-worktrees': true,
        browser: false,
        'task-sources': true,
        'agent-capabilities': true,
        'setup-script': true
      },
      coreDoneCount: 8
    })

    expect(renderToStaticMarkup(<SettingsProgressProbe />)).toContain('8/9')
  })
})
