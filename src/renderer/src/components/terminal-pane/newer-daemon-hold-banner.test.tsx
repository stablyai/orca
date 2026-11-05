// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import { NewerDaemonHoldBanner } from './NewerDaemonHoldBanner'
import {
  holdPaneForNewerDaemon,
  newerDaemonHoldStore,
  reopenHeldTerminals
} from './newer-daemon-hold-state'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

let paneElement: HTMLDivElement
let root: Root
let reopenNewerDaemonTerminals: ReturnType<typeof vi.fn<() => Promise<NewerDaemonReopenResult>>>

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const OTHER_PANE_KEY = makePaneKey('tab-2', LEAF_ID)

function hold(paneKey: string, resumable: boolean): ReturnType<typeof vi.fn> {
  const release = vi.fn(() => Promise.resolve({ reopened: true, agentResumed: resumable }))
  holdPaneForNewerDaemon(paneKey, { resumable, release })
  return release
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NewerDaemonHoldBanner tabId={TAB_ID} leafId={LEAF_ID} />)
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(paneElement.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  newerDaemonHoldStore.setState({ panes: {} })
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  reopenNewerDaemonTerminals = vi.fn(() => Promise.resolve({ reopened: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { reopenNewerDaemonTerminals } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
})

describe('NewerDaemonHoldBanner', () => {
  it('dismisses only this pane, which stays held and still reopens with the others', async () => {
    const release = hold(PANE_KEY, false)
    const otherRelease = hold(OTHER_PANE_KEY, false)
    await render()
    await act(async () => button('Dismiss').click())
    expect(paneElement.textContent).toBe('')
    expect(newerDaemonHoldStore.getState().panes[PANE_KEY]?.phase).toBe('held')
    expect(newerDaemonHoldStore.getState().panes[OTHER_PANE_KEY]?.dismissed).toBe(false)
    expect(release).not.toHaveBeenCalled()
    await act(async () => reopenHeldTerminals(PANE_KEY))
    expect(release).toHaveBeenCalledTimes(1)
    expect(otherRelease).toHaveBeenCalledTimes(1)
  })
})
