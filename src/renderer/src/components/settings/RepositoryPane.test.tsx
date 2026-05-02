import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('./BaseRefPicker', () => ({
  BaseRefPicker: () => <div>Base ref picker</div>
}))

vi.mock('./SparsePresetSettingsSection', () => ({
  SparsePresetSettingsSection: () => <div>Sparse presets</div>
}))

import { getRepositoryPaneSearchEntries, RepositoryPane } from './RepositoryPane'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#737373',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

describe('RepositoryPane Docker isolation default', () => {
  it('includes the default isolation setting in search entries', () => {
    expect(getRepositoryPaneSearchEntries(makeRepo()).map((entry) => entry.title)).toContain(
      'Default Isolation'
    )
  })

  it('renders the host and docker choices for git repositories', () => {
    const updateRepo = vi.fn()
    const markup = renderToStaticMarkup(
      <RepositoryPane
        repo={makeRepo({ defaultIsolation: 'docker' })}
        yamlHooks={null}
        hasHooksFile={false}
        mayNeedUpdate={false}
        updateRepo={updateRepo}
        removeRepo={vi.fn()}
      />
    )

    expect(markup).toContain('Default isolation for new worktrees')
    expect(markup).toContain('Host')
    expect(markup).toContain('Docker')
    expect(markup).toContain('aria-pressed="true"')
  })
})
