// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { LanguageServerStatusBar } from './LanguageServerStatusBar'
import { applyLanguageServerStatusEvent } from './language-server-status-subscriber'
import { resetLanguageServerStatusForTests } from './language-server-status-store'

// sonner is not imported by the component, but the subscriber file imports it;
// keep the mock so the transitive import is inert in this unit.
vi.mock('sonner', () => ({ toast: vi.fn() }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetLanguageServerStatusForTests()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

function renderStatus(): Promise<void> {
  return new Promise((resolve) => {
    root.render(<LanguageServerStatusBar />)
    // Flush the React commit (happy-dom + createRoot are sync-ish; one task).
    setTimeout(resolve, 0)
  })
}

describe('LanguageServerStatusBar', () => {
  it('renders nothing when there is no progress or degraded hint', async () => {
    await renderStatus()
    expect(container.querySelector('[data-testid="language-server-status"]')).toBeNull()
  })

  it('renders the $/progress projection while clangd is indexing', async () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing 42%' })
    await renderStatus()
    const node = container.querySelector('[data-testid="language-server-status"]')
    expect(node?.textContent).toBe('clangd: indexing 42%')
  })

  it('clears the status text when a null progress event arrives', async () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing 42%' })
    await renderStatus()
    applyLanguageServerStatusEvent({ kind: 'progress', text: null })
    await renderStatus()
    expect(container.querySelector('[data-testid="language-server-status"]')).toBeNull()
  })

  it('prefers the persistent degraded hint over the transient progress text', async () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing' })
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'install clangd 12+' })
    await renderStatus()
    const node = container.querySelector('[data-testid="language-server-status"]')
    expect(node?.textContent).toBe('install clangd 12+')
  })
})
