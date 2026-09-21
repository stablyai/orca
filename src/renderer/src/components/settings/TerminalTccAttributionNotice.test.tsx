// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MANAGE_SESSIONS_SECTION_ID,
  TerminalTccAttributionNotice
} from './TerminalTccAttributionNotice'

const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()
const setSettingsSearchQuery = vi.fn()

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: {
      openSettingsTarget: typeof openSettingsTarget
      openSettingsPage: typeof openSettingsPage
      setSettingsSearchQuery: typeof setSettingsSearchQuery
    }) => unknown
  ) => selector({ openSettingsTarget, openSettingsPage, setSettingsSearchQuery })
}))

let container: HTMLDivElement
let root: Root

function stubAttributionHealth(
  health: 'intact' | 'severed' | 'unknown',
  deferredReplacement: {
    reason: 'severed_tcc_attribution' | 'stale_bundle'
    liveSessionCount: number | null
    observedAtMs: number
  } | null = null
): void {
  Object.assign(window, {
    api: {
      pty: {
        management: {
          macTccAttribution: vi.fn(async () => ({ health, deferredReplacement }))
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

it('renders the remedy banner only while attribution is severed', async () => {
  stubAttributionHealth('severed')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice />)
  })
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('macOS permission grants aren’t reaching terminals')
  expect(alert?.textContent).toContain('-25211')

  stubAttributionHealth('intact')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice key="fresh" />)
  })
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('explains why the daemon was preserved when replacement was declined for live sessions', async () => {
  stubAttributionHealth('severed', {
    reason: 'severed_tcc_attribution',
    liveSessionCount: 20,
    observedAtMs: 1
  })
  await act(async () => {
    root.render(<TerminalTccAttributionNotice />)
  })
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('Documents, Desktop and Downloads')
  expect(alert?.textContent).toContain('live terminal sessions (20)')

  stubAttributionHealth('severed', { reason: 'stale_bundle', liveSessionCount: 3, observedAtMs: 1 })
  await act(async () => {
    root.render(<TerminalTccAttributionNotice key="other-reason" />)
  })
  expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
    'live terminal sessions'
  )
})

it('navigates to Manage Sessions from the banner action', async () => {
  stubAttributionHealth('severed')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice />)
  })

  const button = container.querySelector('button')
  expect(button?.textContent).toContain('Open Manage Sessions')
  await act(async () => {
    button?.click()
  })

  expect(setSettingsSearchQuery).toHaveBeenCalledWith('')
  expect(openSettingsTarget).toHaveBeenCalledWith({
    pane: 'terminal',
    repoId: null,
    sectionId: MANAGE_SESSIONS_SECTION_ID
  })
  expect(openSettingsPage).toHaveBeenCalled()
})

it('hides the navigation button on the Manage Sessions surface itself', async () => {
  stubAttributionHealth('severed')
  await act(async () => {
    root.render(<TerminalTccAttributionNotice showManageSessionsButton={false} />)
  })
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.querySelector('button')).toBeNull()
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

it('fails closed when the attribution probe is unavailable', async () => {
  Object.assign(window, { api: { pty: {} } })
  await act(async () => {
    root.render(<TerminalTccAttributionNotice />)
  })
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
