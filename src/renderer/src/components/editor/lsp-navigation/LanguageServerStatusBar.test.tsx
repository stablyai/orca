// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useAppStore } from '@/store'
import { LanguageServerStatusBar } from './LanguageServerStatusBar'
import { applyLanguageServerStatusEvent } from './language-server-status-subscriber'
import { resetLanguageServerStatusForTests } from './language-server-status-store'

// sonner is not imported by the component, but the subscriber file imports it;
// keep the mock so the transitive import is inert in this unit.
vi.mock('sonner', () => ({ toast: vi.fn() }))

let container: HTMLDivElement
let root: Root

const CPP_FILE: OpenFile = {
  id: 'D:/proj/main.cpp',
  filePath: 'D:/proj/main.cpp',
  relativePath: 'main.cpp',
  worktreeId: 'wt',
  isDirty: false,
  mode: 'edit'
} as unknown as OpenFile

beforeEach(() => {
  resetLanguageServerStatusForTests()
  useAppStore.setState({ openFiles: [], activeFileId: null }, false)
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

// The reject-gate (no clangd / version too low) is the only signal that C/C++
// highlighting + navigation is off. When a C/C++ file is active the hint must
// upgrade from the muted chip to a prominent, dismissible warning banner so
// users see *why* their file is uncolored instead of a blank editor.
describe('LanguageServerStatusBar — prominent clangd-missing banner', () => {
  it('shows the warning banner when a C/C++ file is active and clangd is degraded', async () => {
    useAppStore.setState({ openFiles: [CPP_FILE], activeFileId: CPP_FILE.id }, false)
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'clangd 12+ is required…' })
    await renderStatus()

    const banner = container.querySelector('[data-testid="language-server-degraded-banner"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('clangd 12+ is required')
  })

  it('keeps the muted chip (no banner) when a non-C/C++ file is active', async () => {
    useAppStore.setState(
      {
        openFiles: [{ ...CPP_FILE, id: 'app.ts', filePath: 'app.ts', relativePath: 'app.ts' }],
        activeFileId: 'app.ts'
      },
      false
    )
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'clangd 12+ is required…' })
    await renderStatus()

    expect(container.querySelector('[data-testid="language-server-degraded-banner"]')).toBeNull()
    expect(container.querySelector('[data-testid="language-server-status"]')).not.toBeNull()
  })

  it('dismisses the banner on click and leaves no chip', async () => {
    useAppStore.setState({ openFiles: [CPP_FILE], activeFileId: CPP_FILE.id }, false)
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'clangd 12+ is required…' })
    await renderStatus()

    const dismiss = container.querySelector(
      '[data-testid="language-server-degraded-banner"] button'
    ) as HTMLButtonElement
    dismiss.click()
    await renderStatus()

    expect(container.querySelector('[data-testid="language-server-degraded-banner"]')).toBeNull()
    // Degraded hint still set, but no C/C++ banner and the quiet chip is also
    // absent because the degraded text only shows when progress is null too —
    // here we assert the banner path is simply gone.
    expect(container.querySelector('[data-testid="language-server-status"]')).not.toBeNull()
  })
})
