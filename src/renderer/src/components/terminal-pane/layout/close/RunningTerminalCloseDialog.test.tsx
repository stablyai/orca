// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  useRunningTerminalCloseConfirmStore,
  type RunningTerminalCloseConfirmRequest
} from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import RunningTerminalCloseDialog from './RunningTerminalCloseDialog'

const initialState = useAppStore.getInitialState()
const mountedRoots: Root[] = []

// Advance a clock past the store’s 350ms queued-request guard instead of racing real time.
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

beforeEach(() => {
  useAppStore.setState(initialState, true)
  // Keep time monotonic because the singleton store retains guard deadlines between tests.
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

describe('RunningTerminalCloseDialog', () => {
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
})
