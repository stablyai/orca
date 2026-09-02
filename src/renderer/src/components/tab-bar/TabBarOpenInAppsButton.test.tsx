// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { resolvePrimaryOpenInApplication, TabBarOpenInAppsButton } from './TabBarOpenInAppsButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Why: Radix popper measures the trigger with ResizeObserver, which happy-dom lacks.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const {
  mockState,
  openInExternalEditorMock,
  openSettingsPageMock,
  openSettingsTargetMock,
  setRecentOpenInApplicationIdMock
} = vi.hoisted(() => ({
  mockState: {
    worktreesByRepo: {} as Record<string, { id: string; repoId: string; path: string }[]>,
    repos: [] as { id: string; connectionId?: string | null }[],
    settings: {
      activeRuntimeEnvironmentId: null as string | null,
      openInApplications: [] as { id: string; label: string; command: string }[]
    },
    recentOpenInApplicationId: null as string | null
  },
  openInExternalEditorMock: vi.fn(),
  openSettingsPageMock: vi.fn(),
  openSettingsTargetMock: vi.fn(),
  setRecentOpenInApplicationIdMock: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    if (!values) {
      return fallback
    }
    return Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
  }
}))

vi.mock('@/store', () => {
  const getState = (): Record<string, unknown> => ({
    ...mockState,
    openSettingsPage: openSettingsPageMock,
    openSettingsTarget: openSettingsTargetMock,
    setRecentOpenInApplicationId: setRecentOpenInApplicationIdMock
  })
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(getState()),
    { getState }
  )
  return { useAppStore }
})

const vscode: OpenInApplication = { id: 'vscode', label: 'VS Code', command: 'code' }
const cursor: OpenInApplication = { id: 'cursor', label: 'Cursor', command: 'cursor' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mockState.worktreesByRepo = {
    'repo-1': [{ id: 'repo-1::/tmp/ws', repoId: 'repo-1', path: '/tmp/ws' }]
  }
  mockState.repos = [{ id: 'repo-1', connectionId: null }]
  mockState.settings = { activeRuntimeEnvironmentId: null, openInApplications: [vscode, cursor] }
  mockState.recentOpenInApplicationId = null
  openInExternalEditorMock.mockReset().mockResolvedValue({ ok: true })
  openSettingsPageMock.mockReset()
  openSettingsTargetMock.mockReset()
  setRecentOpenInApplicationIdMock.mockReset()
  Object.assign(window, { api: { shell: { openInExternalEditor: openInExternalEditorMock } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(worktreeId = 'repo-1::/tmp/ws'): void {
  act(() => {
    root.render(
      createElement(TooltipProvider, null, createElement(TabBarOpenInAppsButton, { worktreeId }))
    )
  })
}

function primaryButton(): HTMLButtonElement {
  const button = container.querySelector('button[aria-label^="Open in"]')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('primary button not found')
  }
  return button
}

describe('resolvePrimaryOpenInApplication', () => {
  it('prefers the most recently launched app and falls back to the first one', () => {
    expect(resolvePrimaryOpenInApplication([vscode, cursor], 'cursor')).toBe(cursor)
    expect(resolvePrimaryOpenInApplication([vscode, cursor], 'missing')).toBe(vscode)
    expect(resolvePrimaryOpenInApplication([vscode, cursor], null)).toBe(vscode)
    expect(resolvePrimaryOpenInApplication([], 'vscode')).toBeNull()
  })

  it('skips an unavailable recent app for the first available one, else keeps it', () => {
    const onlyCursor = (application: OpenInApplication): boolean => application.id === 'cursor'
    expect(resolvePrimaryOpenInApplication([vscode, cursor], 'vscode', onlyCursor)).toBe(cursor)
    expect(resolvePrimaryOpenInApplication([vscode, cursor], null, onlyCursor)).toBe(cursor)
    expect(resolvePrimaryOpenInApplication([vscode, cursor], 'vscode', () => false)).toBe(vscode)
    expect(resolvePrimaryOpenInApplication([vscode, cursor], null, () => false)).toBe(vscode)
  })
})

describe('TabBarOpenInAppsButton', () => {
  it('renders nothing when the worktree is unknown (floating terminals)', () => {
    render('global-floating-terminal')
    expect(container.querySelector('button')).toBeNull()
  })

  it('opens the workspace in the first configured app and remembers it', async () => {
    render()
    const button = primaryButton()
    expect(button.textContent).toBe('VS Code')
    expect(button.getAttribute('aria-label')).toBe('Open in VS Code')
    expect(container.querySelector('button[aria-label="More apps"]')).not.toBeNull()

    await act(async () => {
      button.click()
      await Promise.resolve()
    })

    expect(setRecentOpenInApplicationIdMock).toHaveBeenCalledWith('vscode')
    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/tmp/ws',
      command: 'code',
      connectionId: null
    })
  })

  it('promotes the most recently launched app to the primary action', () => {
    mockState.recentOpenInApplicationId = 'cursor'
    render()
    expect(primaryButton().textContent).toBe('Cursor')
  })

  it('prefers an app that can open an SSH workspace over a local-only recent one', () => {
    mockState.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]
    mockState.recentOpenInApplicationId = 'cursor'
    render()
    // Why: only VS Code supports SSH workspaces, so Cursor is "Local only" on a remote repo.
    expect(primaryButton().textContent).toBe('VS Code')
    expect(primaryButton().disabled).toBe(false)
  })

  it('disables the primary action and keeps its tooltip reachable when no app can open the workspace here', async () => {
    mockState.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]
    mockState.settings = { activeRuntimeEnvironmentId: null, openInApplications: [cursor] }
    render()
    expect(primaryButton().textContent).toBe('Cursor')
    expect(primaryButton().disabled).toBe(true)

    // Why: a disabled button gets no focus or pointer events, so the wrapper must be the focusable tooltip trigger.
    const trigger = primaryButton().parentElement
    if (!(trigger instanceof HTMLElement)) {
      throw new Error('tooltip trigger not found')
    }
    expect(trigger.getAttribute('data-slot')).toBe('tooltip-trigger')
    expect(trigger.tabIndex).toBe(0)

    await act(async () => {
      trigger.focus()
      await Promise.resolve()
    })

    const tooltip = document.querySelector('[data-slot="tooltip-content"]')
    expect(tooltip?.textContent).toContain('Open in Cursor')
    expect(tooltip?.textContent).toContain('Local only')
  })

  it('does not make the wrapper focusable while the primary button is enabled', () => {
    render()
    expect(primaryButton().parentElement?.hasAttribute('tabindex')).toBe(false)
  })

  it('lists every configured app in the dropdown and remembers the one launched from it', async () => {
    render()
    const chevron = container.querySelector('button[aria-label="More apps"]')
    if (!(chevron instanceof HTMLButtonElement)) {
      throw new Error('chevron not found')
    }

    await act(async () => {
      chevron.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    const items = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-item"]'))
    expect(items.map((item) => item.textContent)).toEqual([
      'VS Code',
      'Cursor',
      'Customize apps...'
    ])

    await act(async () => {
      ;(items[1] as HTMLElement).click()
      await Promise.resolve()
    })

    expect(setRecentOpenInApplicationIdMock).toHaveBeenCalledWith('cursor')
    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/tmp/ws',
      command: 'cursor',
      connectionId: null
    })
  })

  it('falls back to a settings shortcut when no apps are configured', () => {
    mockState.settings = { activeRuntimeEnvironmentId: null, openInApplications: [] }
    render()
    const button = container.querySelector(
      'button[aria-label="Add apps to open this workspace in"]'
    )
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('empty-state button not found')
    }
    expect(button.textContent).toBe('Open in')

    act(() => {
      button.click()
    })

    expect(openSettingsTargetMock).toHaveBeenCalledWith({
      pane: 'general',
      repoId: null,
      sectionId: 'general-open-in-apps'
    })
    expect(openSettingsPageMock).toHaveBeenCalled()
  })
})
