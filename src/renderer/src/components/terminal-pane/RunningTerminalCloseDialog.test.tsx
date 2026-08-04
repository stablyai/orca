// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  useRunningTerminalCloseConfirmStore,
  type RunningTerminalCloseConfirmRequest
} from '@/store/running-terminal-close-confirm'
import RunningTerminalCloseDialog from './RunningTerminalCloseDialog'

const initialState = useAppStore.getInitialState()
const mountedRoots: Root[] = []

// The store holds off any action for 350 ms after a queued request replaces the visible
// one, so these tests drive a clock instead of racing it.
let clock = 1_000

function advancePastGuard(): void {
  clock += 400
}

async function renderDialog(
  request: Partial<RunningTerminalCloseConfirmRequest> & { onConfirm: () => void },
  updateSettings: AppState['updateSettings']
): Promise<void> {
  useAppStore.setState({ updateSettings })
  useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
    terminalTabId: 'tab-1',
    tabLabel: 'dev server',
    copyKind: 'command',
    ...request
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<RunningTerminalCloseDialog />)
  })
}

function getButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getCheckbox(): HTMLButtonElement {
  const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
  if (!checkbox) {
    throw new Error('Checkbox not found')
  }
  return checkbox
}

describe('RunningTerminalCloseDialog', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    // Monotonic across tests: the store is a singleton, so winding the clock back would
    // leave a previous test's guard deadline in the future and block every action.
    clock += 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(async () => {
    while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm !== null) {
      advancePastGuard()
      useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    }
    vi.mocked(Date.now).mockRestore()
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    useAppStore.setState(initialState, true)
  })

  it('names the tab so a background close is not ambiguous', async () => {
    const onConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm }, updateSettings)

    expect(document.body.textContent).toContain('Stop running command?')
    expect(document.body.textContent).toContain('dev server')

    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('uses the agent copy for an agent pane', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm: vi.fn(), copyKind: 'agent' }, updateSettings)

    expect(document.body.textContent).toContain('Stop this agent?')
    expect(getButton('Stop Agent')).toBeTruthy()
  })

  it('persists the opt-out when "don\'t ask again" is checked', async () => {
    const onConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm }, updateSettings)

    await act(async () => {
      getCheckbox().click()
    })
    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      skipCloseTerminalWithRunningProcessConfirm: true
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  // Why: this queue opens after an async probe while the pinned queue opens synchronously,
  // so both can be pending at once. Two modal overlays + focus traps is the bug.
  it('waits for a visible pinned confirmation instead of stacking a second modal', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      pinnedTabCloseConfirm: { tabLabel: 'pinned tab', onConfirm: vi.fn() }
    })

    await renderDialog({ onConfirm: vi.fn() }, updateSettings)

    expect(document.body.textContent).not.toContain('Stop running command?')

    await act(async () => {
      useAppStore.setState({ pinnedTabCloseConfirm: null })
    })

    expect(document.body.textContent).toContain('Stop running command?')
  })

  it('does not carry the opt-out tick over to the next queued tab', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const nextOnConfirm = vi.fn()

    await renderDialog({ onConfirm: vi.fn(), onCancel: vi.fn() }, updateSettings)
    await act(async () => {
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId: 'tab-2',
        tabLabel: 'build watcher',
        copyKind: 'command',
        onConfirm: nextOnConfirm
      })
    })

    await act(async () => {
      getCheckbox().click()
    })
    await act(async () => {
      getButton('Cancel').click()
    })

    expect(document.body.textContent).toContain('build watcher')
    expect(getCheckbox().getAttribute('data-state')).toBe('unchecked')

    advancePastGuard()
    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(updateSettings).not.toHaveBeenCalled()
    expect(nextOnConfirm).toHaveBeenCalledTimes(1)
  })

  it('drops a queued prompt once the user opts out of asking again', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const onConfirm = vi.fn()
    const nextOnConfirm = vi.fn()

    await renderDialog({ onConfirm }, updateSettings)
    await act(async () => {
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId: 'tab-2',
        tabLabel: 'build watcher',
        copyKind: 'command',
        onConfirm: nextOnConfirm
      })
    })

    await act(async () => {
      getCheckbox().click()
    })
    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      skipCloseTerminalWithRunningProcessConfirm: true
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(nextOnConfirm).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('build watcher')
  })

  it('cancels without closing and shows the next queued tab', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const nextOnConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm, onCancel }, updateSettings)
    await act(async () => {
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId: 'tab-2',
        tabLabel: 'build watcher',
        copyKind: 'command',
        onConfirm: nextOnConfirm
      })
    })

    await act(async () => {
      getButton('Cancel').click()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('build watcher')

    advancePastGuard()
    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(nextOnConfirm).toHaveBeenCalledTimes(1)
  })
})
