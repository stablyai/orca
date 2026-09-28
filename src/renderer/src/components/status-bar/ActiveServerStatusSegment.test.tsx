// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActiveServerStatusSegment } from './ActiveServerStatusSegment'

type TestState = {
  settings: { activeRuntimeEnvironmentId: string | null } | null
  runtimeEnvironments: { id: string; name: string; source?: 'manual' | 'ephemeral-vm' }[]
  setActiveRuntimeEnvironmentPreference: (id: string | null) => Promise<boolean>
}

const { switchServer, pairedWebClient } = vi.hoisted(() => ({
  switchServer: vi.fn<(id: string | null) => Promise<boolean>>(),
  pairedWebClient: { value: false }
}))

const store = createStore<TestState>(() => ({
  settings: null,
  runtimeEnvironments: [],
  setActiveRuntimeEnvironmentPreference: switchServer
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: TestState) => unknown) => useStore(store, selector)
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => pairedWebClient.value
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function renderSegment(iconOnly = false): void {
  render(
    <TooltipProvider>
      <ActiveServerStatusSegment iconOnly={iconOnly} />
    </TooltipProvider>
  )
}

async function openMenu(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' })
  await screen.findByRole('menu')
}

beforeEach(() => {
  pairedWebClient.value = false
  switchServer.mockReset()
  switchServer.mockImplementation(async (id) => {
    store.setState({ settings: { activeRuntimeEnvironmentId: id } })
    return true
  })
  store.setState({
    settings: { activeRuntimeEnvironmentId: 'work' },
    runtimeEnvironments: [
      { id: 'priv', name: 'Private server' },
      { id: 'work', name: 'Work server' },
      { id: 'temporary', name: 'Temporary VM', source: 'ephemeral-vm' }
    ]
  })
})

afterEach(cleanup)

describe('ActiveServerStatusSegment', () => {
  it('shows the active server and marks it in the real dropdown', async () => {
    renderSegment()

    expect(screen.getByRole('button').textContent).toContain('Work server')
    await openMenu()

    expect(
      screen.getByRole('menuitemradio', { name: 'Work server' }).getAttribute('aria-checked')
    ).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Local desktop' })).toBeDefined()
    expect(screen.queryByRole('menuitemradio', { name: 'Temporary VM' })).toBeNull()
  })

  it('switches between paired servers using the existing preference action', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    await waitFor(() => {
      expect(switchServer).toHaveBeenCalledExactlyOnceWith('priv')
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'Active Server: Private server'
      )
    })
  })

  it('can return to the local desktop', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local desktop' }))

    await waitFor(() => {
      expect(switchServer).toHaveBeenCalledExactlyOnceWith(null)
      expect(screen.getByRole('button').textContent).toContain('Local desktop')
    })
  })

  it('does not switch when selecting the current server', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Work server' }))

    expect(switchServer).not.toHaveBeenCalled()
  })

  it('keeps the old label until a slow switch finishes and prevents another request', async () => {
    let finishSwitch: ((value: boolean) => void) | undefined
    switchServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSwitch = resolve
        })
    )
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    const trigger = screen.getByRole('button')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    expect(trigger.textContent).toContain('Work server')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(switchServer).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishSwitch?.(true)
    })
    expect(trigger.hasAttribute('disabled')).toBe(false)
  })

  it('keeps the current server and allows retry after a failed switch', async () => {
    switchServer.mockResolvedValue(false)
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('button').textContent).toContain('Work server')
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))
    await waitFor(() => expect(switchServer).toHaveBeenCalledTimes(2))
  })

  it('retains an accessible active-server name in icon-only mode', async () => {
    renderSegment(true)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Active Server: Work server')
    expect(screen.getByRole('button').textContent).toBe('')
    await openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Private server' })).toBeDefined()
  })

  it.each(['unpaired', 'ephemeral-only', 'paired-web', 'loading'])(
    'does not show a desktop default-server selector for %s clients',
    (mode) => {
      if (mode === 'unpaired') {
        store.setState({ runtimeEnvironments: [] })
      }
      if (mode === 'ephemeral-only') {
        store.setState({
          runtimeEnvironments: [{ id: 'temporary', name: 'Temporary VM', source: 'ephemeral-vm' }]
        })
      }
      if (mode === 'paired-web') {
        pairedWebClient.value = true
      }
      if (mode === 'loading') {
        store.setState({ settings: null })
      }
      renderSegment()
      expect(screen.queryByRole('button')).toBeNull()
    }
  )
})
