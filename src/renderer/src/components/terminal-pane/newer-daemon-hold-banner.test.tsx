// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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
const TITLE = 'This terminal was opened in a newer version of Orca'
const BODY = 'Reopen it here to keep working. Your agent session will resume.'
const FAILED_TITLE = "Couldn't reopen this terminal"

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
  it('renders nothing for a pane that is not held', async () => {
    await render()
    expect(paneElement.textContent).toBe('')
  })

  it('promises a resume only for a pane with a resumable agent session', async () => {
    hold(PANE_KEY, true)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).toContain(BODY)
    hold(PANE_KEY, false)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
  })

  it('shows Reopening while the stop runs, then nothing once released', async () => {
    let finish!: (result: NewerDaemonReopenResult) => void
    reopenNewerDaemonTerminals.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    hold(PANE_KEY, true)
    await render()
    await act(async () => button('Reopen terminal').click())
    expect(button('Reopening…').disabled).toBe(true)
    expect(paneElement.textContent).not.toContain('Dismiss')
    await act(async () => finish({ reopened: true }))
    expect(paneElement.textContent).toBe('')
  })

  it('offers Try again after an unconfirmed stop, but not to a pane held afterwards', async () => {
    reopenNewerDaemonTerminals.mockResolvedValue({ reopened: false })
    hold(PANE_KEY, true)
    await render()
    await act(async () => button('Reopen terminal').click())
    expect(paneElement.textContent).toContain(FAILED_TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
    expect(button('Try again').disabled).toBe(false)
    hold(PANE_KEY, true)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).not.toContain(FAILED_TITLE)
  })

  it('counts every held pane in the label, since one click reopens them all', async () => {
    hold(PANE_KEY, false)
    await render()
    expect(button('Reopen terminal')).toBeTruthy()
    hold(OTHER_PANE_KEY, false)
    await render()
    expect(button('Reopen 2 terminals')).toBeTruthy()
  })

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

  it('offers Dismiss after a failed stop', async () => {
    reopenNewerDaemonTerminals.mockResolvedValue({ reopened: false })
    hold(PANE_KEY, false)
    await render()
    expect(button('Dismiss')).toBeTruthy()
    await act(async () => button('Reopen terminal').click())
    expect(button('Dismiss')).toBeTruthy()
  })
})
