// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import type { ChatImportSetupStatus } from '../../../../preload/api-types'
import { WebChatBrowserLinkSection } from './WebChatBrowserLinkSection'

// Why: a STABLE status object reference keeps getStatus().then(setState) from
// retriggering the mount load effect (the render-test infinite-loop trap).
const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  clipboardWrite: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

// Why: SearchableSetting pulls the zustand app store; stub it to keep the render
// test isolated to this section's own markup.
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: ReactNode }) => <>{children}</>
}))

function makeStatus(overrides?: Partial<ChatImportSetupStatus>): ChatImportSetupStatus {
  return {
    browsers: [
      { id: 'chrome', label: 'Chrome', detected: true, hostInstalled: false },
      { id: 'edge', label: 'Edge', detected: false, hostInstalled: false },
      { id: 'brave', label: 'Brave', detected: true, hostInstalled: true },
      { id: 'chromium', label: 'Chromium', detected: false, hostInstalled: false }
    ],
    lastSyncedBySource: {
      CHATGPT: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      CLAUDE: null,
      GEMINI: null
    },
    extensionDir: '/home/user/.orca/chat-import',
    ...overrides
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderSection(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <WebChatBrowserLinkSection />
      </TooltipProvider>
    )
  })
  // Flush the mount-time getStatus() so the browser rows are painted.
  await flush()
  if (!container) {
    throw new Error('Container was not created')
  }
  return container
}

function installButton(rendered: HTMLElement, browser: string): HTMLButtonElement | null {
  return rendered.querySelector<HTMLButtonElement>(`[data-browser="${browser}"] button`)
}

describe('WebChatBrowserLinkSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset()
    mocks.getStatus.mockResolvedValue(makeStatus())
    mocks.install.mockReset()
    mocks.install.mockResolvedValue({ ok: true })
    mocks.clipboardWrite.mockClear()
    mocks.toastSuccess.mockClear()
    mocks.toastError.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chatImportSetup: { getStatus: mocks.getStatus, install: mocks.install },
        ui: { writeClipboardText: mocks.clipboardWrite }
      }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('enables install for a detected browser and disables it for an undetected one', async () => {
    const rendered = await renderSection()

    const chrome = installButton(rendered, 'chrome')
    const edge = installButton(rendered, 'edge')
    expect(chrome).not.toBeNull()
    expect(edge).not.toBeNull()
    expect(chrome?.disabled).toBe(false)
    expect(edge?.disabled).toBe(true)
  })

  it('installs the clicked browser and re-fetches status afterwards', async () => {
    const rendered = await renderSection()
    expect(mocks.getStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      installButton(rendered, 'chrome')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(mocks.install).toHaveBeenCalledWith('chrome')
    // Mount load + post-install refresh.
    expect(mocks.getStatus).toHaveBeenCalledTimes(2)
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('labels an already-linked browser and lets it reinstall', async () => {
    const rendered = await renderSection()

    expect(rendered.textContent).toContain('Linked')
    expect(rendered.textContent).toContain('Reinstall')
    expect(installButton(rendered, 'brave')?.disabled).toBe(false)
  })

  it('renders a synced source time and a "never" state for empty sources', async () => {
    const rendered = await renderSection()

    expect(rendered.textContent).toContain('ChatGPT')
    expect(rendered.textContent).toContain('Claude.ai')
    expect(rendered.textContent).toContain('Gemini')
    // CHATGPT was synced 3 days ago; CLAUDE/GEMINI never synced.
    expect(rendered.textContent).toContain('3d ago')
    expect(rendered.textContent).toContain('Never')
  })

  it('copies the extension folder path from the load guide', async () => {
    const rendered = await renderSection()

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Copy extension folder path"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(mocks.clipboardWrite).toHaveBeenCalledWith('/home/user/.orca/chat-import')
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })
})
