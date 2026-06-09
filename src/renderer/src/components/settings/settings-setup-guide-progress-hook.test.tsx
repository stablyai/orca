import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
      'task-sources': true,
      'agent-capabilities': false,
      'setup-script': false
    },
    coreDoneCount: 5,
    coreTotal: 8
  }
}

function SettingsProgressProbe(): React.JSX.Element {
  const progress = useSettingsSetupGuideProgress(true)
  return <span>{`${progress.doneCount}/${progress.total}`}</span>
}

describe('useSettingsSetupGuideProgress', () => {
  it('uses the same setup progress path as the main sidebar', () => {
    mocks.useSetupGuideProgress.mockReturnValue(makeProgress())

    expect(renderToStaticMarkup(<SettingsProgressProbe />)).toContain('5/8')
    expect(mocks.useSetupGuideProgress).toHaveBeenCalledWith(true, false, false)
  })
})
