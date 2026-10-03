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

  it('confirms a running-terminal close without opting out', async () => {
    const onConfirm = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)

    await renderDialog({ onConfirm }, updateSettings)

    await act(async () => {
      getButton('Stop and Close').click()
    })

    expect(updateSettings).not.toHaveBeenCalled()
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

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      useAppStore.setState({ pinnedTabCloseConfirm: null })
    })

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
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

  it.each(['confirm', 'cancel'] as const)(
    'keeps a group close atomic when the user chooses %s',
    async (decision) => {
      const onConfirm = vi.fn()
      const onCancel = vi.fn()
      const updateSettings = vi.fn().mockResolvedValue(undefined)

      await renderDialog(
        {
          terminalTabId: 'tab-cluster:development',
          tabLabel: 'Development',
          copyKind: 'agent',
          groupTerminals: [
            { terminalTabId: 'build', tabLabel: 'Build watcher', copyKind: 'command' },
            { terminalTabId: 'agent', tabLabel: 'Review agent', copyKind: 'agent' }
          ],
          onConfirm,
          onCancel
        },
        updateSettings
      )

      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      expect(document.body.textContent).toContain('Development')
      expect(document.body.textContent).not.toContain('Build watcher')
      const disclosure = document.body.querySelector<HTMLButtonElement>('[aria-expanded]')
      if (!disclosure) {
        throw new Error('Missing running-terminal disclosure')
      }
      await act(async () => disclosure.click())

      expect(document.body.querySelectorAll('li')).toHaveLength(2)
      expect(document.body.textContent).toContain('Build watcher')
      expect(document.body.textContent).toContain('Review agent')
      expect(onConfirm).not.toHaveBeenCalled()
      await act(async () => {
        getButton(decision === 'confirm' ? 'Stop Agent' : 'Cancel').click()
      })

      expect(onConfirm).toHaveBeenCalledTimes(decision === 'confirm' ? 1 : 0)
      expect(onCancel).toHaveBeenCalledTimes(decision === 'cancel' ? 1 : 0)
      expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(updateSettings).not.toHaveBeenCalled()
    }
  )
})
