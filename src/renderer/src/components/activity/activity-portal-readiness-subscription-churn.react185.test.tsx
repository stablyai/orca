/** @vitest-environment happy-dom */
import { act, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useActivityTerminalPortalStatus } from './ActivityPrototypePage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-readiness-churn'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const LEAF_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const PANE_A = `${TAB_ID}:${LEAF_A}`
const PANE_B = `${TAB_ID}:${LEAF_B}`

let root: Root

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function buildNeverReadyRoot(target: HTMLElement): void {
  const tabRoot = document.createElement('div')
  tabRoot.dataset.terminalTabId = TAB_ID
  for (const leafId of [LEAF_A, LEAF_C]) {
    const pane = document.createElement('div')
    pane.dataset.leafId = leafId
    pane.setAttribute('data-pty-id', `pty-${leafId}`)
    pane.appendChild(Object.assign(document.createElement('div'), { className: 'xterm-screen' }))
    Object.defineProperty(pane, 'getClientRects', { value: () => [{}], configurable: true })
    tabRoot.appendChild(pane)
  }
  target.replaceChildren(tabRoot)
}

async function settleReadinessFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('Activity portal readiness subscription churn', () => {
  // Why this bound matters: React raises #185 only after >50 *consecutive* commits that each leave a
  // pending sync/default lane; any commit that leaves none resets nestedUpdateCount. This pins the
  // reason the readiness subscription can never be that source -- its only writer is an rAF callback,
  // and the effect cleanup cancels that frame on every churn step, so a synchronous cascade of
  // subscription churn commits nothing at all. A #185 on this page must come from another setState.
  it('contributes no state updates to a synchronous churn cascade past React nested-update limit', () => {
    const target = document.createElement('div')
    buildNeverReadyRoot(target)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let readinessCommits = 0
    let lastStatus = 'loading'

    function ActivityTerminalSlot(): null {
      const [paneKey, setPaneKey] = useState(PANE_A)
      selectPane = setPaneKey
      const status = useActivityTerminalPortalStatus(target, paneKey)
      if (status !== lastStatus) {
        readinessCommits += 1
        lastStatus = status
      }
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })
    readinessCommits = 0

    act(() => {
      expect(() => {
        for (let index = 0; index < 60; index += 1) {
          flushSync(() => {
            selectPane(index % 2 === 0 ? PANE_B : PANE_A)
          })
        }
      }).not.toThrow()
    })
    expect(readinessCommits).toBe(0)
  })

  it('coalesces pane-key churn and commits the latest readiness', async () => {
    const target = document.createElement('div')
    buildNeverReadyRoot(target)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let renders = 0
    let status = 'loading'

    function ActivityTerminalSlot(): null {
      renders += 1
      const [paneKey, setPaneKey] = useState(PANE_A)
      selectPane = setPaneKey
      status = useActivityTerminalPortalStatus(target, paneKey)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })

    act(() => {
      expect(() => {
        for (let index = 0; index < 29; index += 1) {
          flushSync(() => {
            selectPane(index % 2 === 0 ? PANE_B : PANE_A)
          })
        }
      }).not.toThrow()
    })
    expect(renders).toBeLessThanOrEqual(31)

    await settleReadinessFrame()
    expect(status).toBe('unavailable')
    expect(renders).toBeLessThanOrEqual(32)
  })

  it('reports a later loading pane truthfully after rapid readiness changes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const target = document.createElement('div')
    buildNeverReadyRoot(target)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let status = 'loading'

    function ActivityTerminalSlot(): null {
      const [paneKey, setPaneKey] = useState(PANE_B)
      selectPane = setPaneKey
      status = useActivityTerminalPortalStatus(target, paneKey)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<ActivityTerminalSlot />))
    await settleReadinessFrame()
    expect(status).toBe('unavailable')

    for (let index = 0; index < 10; index += 1) {
      const paneKey = index % 2 === 0 ? PANE_A : PANE_B
      act(() => selectPane(paneKey))
      await settleReadinessFrame()
      expect(status).toBe(paneKey === PANE_A ? 'loading' : 'unavailable')
    }

    act(() => selectPane(PANE_A))
    await settleReadinessFrame()
    expect(status).toBe('loading')
  })
})
