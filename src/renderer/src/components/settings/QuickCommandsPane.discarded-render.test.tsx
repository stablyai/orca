// @vitest-environment happy-dom

import React, { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const storeState = vi.hoisted(() => ({
  repos: [],
  activeRepoId: null,
  runtimeEnvironments: [],
  runtimeStatusByEnvironmentId: new Map(),
  runtimeTerminalQuickCommands: new Map(),
  loadRuntimeTerminalQuickCommands: async () => {},
  settings: {}
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./QuickCommandsToolbar', () => ({ QuickCommandsToolbar: () => null }))
vi.mock('./QuickCommandsList', () => ({ QuickCommandsList: () => null }))
vi.mock('@/components/terminal-quick-commands/TerminalQuickCommandDialog', () => ({
  createTerminalQuickCommandDraft: () => ({ id: 'draft', label: '', command: '' }),
  TerminalQuickCommandDialog: ({ mode }: { mode: string }) => (
    <div data-testid="quick-command-dialog">{mode}</div>
  )
}))

import { QuickCommandsPane } from './QuickCommandsPane'

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
const settledSignals = new Set<number>()
let releasePending: (() => void) | null = null

/** Suspends the first render of each unseen signal so the sibling pane's render is discarded. */
function SuspendOnNewSignal({ signal }: { signal: number }): null {
  if (!settledSignals.has(signal)) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        settledSignals.add(signal)
        resolve()
      }
    })
  }
  return null
}

const settings: GlobalSettings = { ...getDefaultSettings('/home/dev'), terminalQuickCommands: [] }

/** Renders the pane beside the suspender inside the Suspense boundary a new signal unwinds. */
function boundary(signal: number): React.JSX.Element {
  return (
    <Suspense fallback={<span data-testid="fallback">loading</span>}>
      <QuickCommandsPane settings={settings} addCommandIntentSignal={signal} />
      <SuspendOnNewSignal signal={signal} />
    </Suspense>
  )
}

beforeEach(() => {
  settledSignals.clear()
  settledSignals.add(0)
  releasePending = null
})

afterEach(cleanup)

describe('QuickCommandsPane add-intent deep link', () => {
  it('opens the add dialog even when the consuming render is discarded', async () => {
    const { rerender } = render(boundary(0))
    expect(screen.queryByTestId('quick-command-dialog')).toBeNull()

    rerender(boundary(7))
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByTestId('quick-command-dialog').textContent).toBe('add')
  })
})
