// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'

vi.mock('../section-layout/SearchableSetting', () => ({
  SearchableSetting: ({ children }) => children
}))
vi.mock('../../sidebar/worktree-list/controls/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: [] })
}))
afterEach(cleanup)

describe('WorkspaceDirectorySetting', () => {
  it('shows the saved path and writes nothing when a padded copy of it is committed', () => {
    const updateSettings = vi.fn()
    render(
      <WorkspaceDirectorySetting
        settings={{ workspaceDir: '/Users/me/dev' } as GlobalSettings}
        updateSettings={updateSettings}
      />
    )
    const input = screen.getByRole('textbox') as HTMLInputElement

    fireEvent.change(input, { target: { value: ' /Users/me/dev' } })
    fireEvent.blur(input)

    expect(input.value).toBe('/Users/me/dev')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
