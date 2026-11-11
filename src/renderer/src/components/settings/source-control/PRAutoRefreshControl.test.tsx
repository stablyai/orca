// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { PRAutoRefreshControl } from './PRAutoRefreshControl'

vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const store = createStore(() => ({ settingsSearchQuery: '' }))
  return {
    useAppStore: Object.assign((select: (s: unknown) => unknown) => useStore(store, select), store)
  }
})

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  await i18n.changeLanguage('en')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

function text(testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
}

describe('PRAutoRefreshControl', () => {
  it('describes the selected cadence as how often it checks, from the shared policy', async () => {
    const onChange = vi.fn()
    await act(async () =>
      root.render(
        <PRAutoRefreshControl cadence="reduced" onChange={onChange} remoteHostName={null} />
      )
    )
    expect(text('pr-auto-refresh-hint')).toBe(
      'Reduced: about every 5 min for the open workspace and every 10 min for other visible ones.'
    )
    expect(text('pr-auto-refresh-host-note')).toBeNull()

    const minimal = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    ).find((button) => button.textContent === 'Minimal')
    if (!minimal) {
      throw new Error('No Minimal option')
    }
    await act(async () => minimal.click())
    expect(onChange).toHaveBeenCalledWith('minimal')
  })

  it('spells out that Off has no timer and what still refreshes', async () => {
    await act(async () =>
      root.render(<PRAutoRefreshControl cadence="off" onChange={() => {}} remoteHostName={null} />)
    )
    expect(text('pr-auto-refresh-hint')).toBe(
      'Off: no timed refresh. Orca still reads when you select a workspace, push, return to the window or refresh manually.'
    )
  })

  it('names the paired host whose timers and clients the setting changes', async () => {
    await act(async () =>
      root.render(
        <PRAutoRefreshControl
          cadence="default"
          onChange={() => {}}
          remoteHostName="Boston build server"
        />
      )
    )
    expect(text('pr-auto-refresh-host-note')).toBe(
      'Applies to Boston build server and every client connected to it.'
    )
    expect(text('pr-auto-refresh-hint')).toBe(
      'Default: about every minute for the open workspace and every 2 min for other visible ones.'
    )
    const group = container.querySelector('[role="radiogroup"]')
    const describedBy = group?.getAttribute('aria-describedby') ?? ''
    for (const id of describedBy.split(' ')) {
      expect(document.getElementById(id)).not.toBeNull()
    }
  })

  it('tells the user it is still reading a remote host and keeps the options disabled', async () => {
    await act(async () =>
      root.render(
        <PRAutoRefreshControl
          cadence={null}
          onChange={() => {}}
          remoteHostName="Boston build server"
        />
      )
    )
    expect(text('pr-auto-refresh-hint')).toBe(
      'Reading the current setting from Boston build server…'
    )
    for (const button of container.querySelectorAll('button[role="radio"]')) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }
  })
})
