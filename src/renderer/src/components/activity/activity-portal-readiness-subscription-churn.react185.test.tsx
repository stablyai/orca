/** @vitest-environment happy-dom */
import { act, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('Activity portal readiness subscription churn', () => {
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

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(status).toBe('unavailable')
    expect(renders).toBeLessThanOrEqual(32)
  })
})
