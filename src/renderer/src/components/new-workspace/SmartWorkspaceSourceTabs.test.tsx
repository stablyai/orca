// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'
import { getSmartWorkspaceNameModes } from './smart-workspace-localized-options'
import { SmartWorkspaceSourceTabs } from './SmartWorkspaceSourceTabs'

const all = getSmartWorkspaceNameModes()
const only = (ids: SmartNameMode[]) => all.filter((item) => ids.includes(item.id))

function renderTabs(mode: SmartNameMode, ids: SmartNameMode[], onModeChange = vi.fn()) {
  render(
    <TooltipProvider>
      <SmartWorkspaceSourceTabs
        model={{ mode, availableModes: only(ids) }}
        onModeChange={onModeChange}
      />
    </TooltipProvider>
  )
  return onModeChange
}

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('SmartWorkspaceSourceTabs', () => {
  it('collapses every task source into one Tasks tab: Smart · Tasks · Branch · Name', () => {
    renderTabs('smart', ['smart', 'github', 'linear', 'jira', 'gitlab', 'branches', 'text'])
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Smart',
      'Tasks',
      'Branch',
      'Name'
    ])
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('shows the source switcher inside Tasks, connected sources in order', () => {
    const onModeChange = renderTabs('linear', ['smart', 'github', 'linear', 'gitlab', 'text'])
    const switcher = screen.getByRole('radiogroup', { name: 'Task source' })
    const radios = [...switcher.querySelectorAll('[role=radio]')]
    expect(radios.map((radio) => radio.textContent)).toEqual(['GitHub', 'Linear', 'GitLab'])
    expect(screen.getByRole('radio', { name: 'Linear' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'GitLab' }))
    expect(onModeChange).toHaveBeenCalledWith('gitlab')
  })

  it('hides the switcher when only one task source is connected', () => {
    renderTabs('github', ['smart', 'github', 'branches', 'text'])
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('reopens Tasks on the last source used', () => {
    const first = renderTabs('linear', ['smart', 'github', 'linear', 'text'])
    fireEvent.click(screen.getByRole('radio', { name: 'Linear' }))
    expect(first).toHaveBeenCalledWith('linear')
    cleanup()
    const second = renderTabs('smart', ['smart', 'github', 'linear', 'text'])
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Tasks' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }))
    expect(second).toHaveBeenCalledWith('linear')
  })
})
