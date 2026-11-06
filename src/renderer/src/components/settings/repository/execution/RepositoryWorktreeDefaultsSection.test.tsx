// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { RepositoryWorktreeDefaultsSection } from './RepositoryWorktreeDefaultsSection'

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('../../../source-control/BaseRefPicker', () => ({
  BaseRefPicker: () => null
}))

vi.mock('../../../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/home/user/project',
  displayName: 'My Project',
  badgeColor: '#000000',
  addedAt: 0
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(
  repo: Repo,
  updateRepo: React.ComponentProps<typeof RepositoryWorktreeDefaultsSection>['updateRepo'],
  options: {
    settings?: Pick<GlobalSettings, 'workspaceDir' | 'worktreeVisibilityDefaults'> | null
    refreshRepo?: (repoId: string) => void | Promise<unknown>
  } = {}
): void {
  act(() => {
    root.render(
      React.createElement(RepositoryWorktreeDefaultsSection, {
        repo,
        settings: options.settings ?? null,
        updateRepo,
        refreshRepo: options.refreshRepo ?? (() => {}),
        forceVisible: true
      })
    )
  })
}

describe('RepositoryWorktreeDefaultsSection — external visibility', () => {
  it('falls back to the effective explicit value when an older host rejects inheritance', async () => {
    const updateRepo = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(
      {
        ...BASE_REPO,
        externalWorktreeVisibility: 'show',
        externalWorktreeVisibilityLegacy: false
      },
      updateRepo
    )

    await act(async () => {
      const select = container.querySelector('select')!
      select.value = 'global'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenNthCalledWith(2, 'repo-1', {
      externalWorktreeVisibility: 'show'
    })
  })
})
