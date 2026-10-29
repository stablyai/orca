// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useAppStore } from '@/store'
import { SidebarTaskNavButton } from './SidebarTaskNavButton'

const initialState = useAppStore.getInitialState()

describe('SidebarTaskNavButton (Azure DevOps quick-open)', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the button reads only the settings and status fields seeded here.
    useAppStore.setState({
      openTaskPage: vi.fn(),
      refreshPreflightStatus: vi.fn(async () => undefined),
      checkLinearConnection: vi.fn(async () => undefined),
      preflightStatusChecked: true,
      linearStatusChecked: true,
      settings: {
        ...initialState.settings,
        showTasksButton: true,
        visibleTaskProviders: ['github', 'azure-devops'],
        defaultTaskSource: 'github'
      }
    } as never)
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('offers an Azure DevOps shortcut when the provider is visible', () => {
    render(<SidebarTaskNavButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Azure DevOps tasks' }))
    expect(useAppStore.getState().openTaskPage).toHaveBeenCalledWith({
      taskSource: 'azure-devops'
    })
  })

  it('hides the shortcut when the provider is not visible', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the button reads only the settings and status fields seeded here.
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, visibleTaskProviders: ['github'] }
    } as never)
    render(<SidebarTaskNavButton />)
    expect(screen.queryByRole('button', { name: 'Open Azure DevOps tasks' })).toBeNull()
  })
})
