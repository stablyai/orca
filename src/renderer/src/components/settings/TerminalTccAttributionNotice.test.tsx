// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalTccAttributionNotice } from './TerminalTccAttributionNotice'

const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()
const setSettingsSearchQuery = vi.fn()

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({ openSettingsTarget, openSettingsPage, setSettingsSearchQuery })
  }
}))

let container: HTMLDivElement
let root: Root

function stubAttributionHealth(health: 'intact' | 'severed' | 'unknown'): void {
  Object.assign(window, {
    api: {
      pty: {
        management: {
          macTccAttribution: vi.fn(async () => ({ health }))
        }
      }
    }
  })
}

beforeEach(() => {
  openSettingsTarget.mockClear()
  openSettingsPage.mockClear()
  setSettingsSearchQuery.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

it('refreshes the warning after the daemon restart remedy settles', async () => {
  stubAttributionHealth('severed')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice refreshRevision={0} />)
  })
  expect(container.querySelector('[role="alert"]')).not.toBeNull()

  stubAttributionHealth('intact')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice refreshRevision={1} />)
  })
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
