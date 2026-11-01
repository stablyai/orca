// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { createUIStore } from '../../store/slices/ui-slice-test-harness'
import { StatusBarVisibilityMenu } from './StatusBarVisibilityMenu'

vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function VisibilityMenu({
  store,
  detectedAgentIds
}: {
  store: ReturnType<typeof createUIStore>
  detectedAgentIds: TuiAgent[]
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(true)
  const statusBarItems = useStore(store, (state) => state.statusBarItems)
  return (
    <>
      <button type="button" onClick={() => setMenuOpen(true)}>
        Open visibility menu
      </button>
      <StatusBarVisibilityMenu
        controller={{
          detectedAgentIds,
          menuOpen,
          menuPoint: { x: 0, y: 0 },
          recordFeatureInteraction: async () => {},
          setMenuOpen,
          statusBarItems,
          toggleStatusBarItem: store.getState().toggleStatusBarItem
        }}
      />
    </>
  )
}

describe('StatusBarVisibilityMenu', () => {
  it('toggles and persists Muse visibility through its real checkbox', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', Object.assign(window, { api: { ui: { set: setUI } } }))
    const store = createUIStore()
    store.setState({ statusBarItems: ['muse'] })
    render(<VisibilityMenu store={store} detectedAgentIds={['muse']} />)

    const checked = screen.getByRole('menuitemcheckbox', { name: 'Muse Usage' })
    expect(checked.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(checked)
    expect(store.getState().statusBarItems).toEqual([])
    expect(setUI).toHaveBeenLastCalledWith({ statusBarItems: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Open visibility menu' }))
    const unchecked = screen.getByRole('menuitemcheckbox', { name: 'Muse Usage' })
    expect(unchecked.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(unchecked)
    expect(store.getState().statusBarItems).toEqual(['muse'])
    expect(setUI).toHaveBeenLastCalledWith({ statusBarItems: ['muse'] })
  })

  it('omits Muse when CLI detection proves it absent', () => {
    render(<VisibilityMenu store={createUIStore()} detectedAgentIds={['kimi']} />)
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Muse Usage' })).toBeNull()
  })
})
