// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH } from '../../../../shared/repo-terminal-theme'
import type { TerminalCustomTheme } from '../../../../shared/terminal-custom-themes'
import { RepositoryTerminalThemeSection } from './RepositoryTerminalThemeSection'

const storeState = vi.hoisted(() => {
  const terminalCustomThemes: TerminalCustomTheme[] = []
  const defaults = {
    theme: 'dark',
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalThemeLight: 'Builtin Tango Light',
    terminalUseSeparateLightTheme: true,
    terminalCustomThemes
  }
  return {
    defaults,
    settings: { ...defaults }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: storeState.settings,
      settingsSearchQuery: ''
    })
}))

// Why: the xterm-backed preview is irrelevant to override writes.
vi.mock('./TerminalSettingsPreview', () => ({
  TerminalSettingsPreview: () => React.createElement('div', { 'data-testid': 'preview' })
}))

const baseRepo: Repo = {
  id: 'repo-1',
  kind: 'git',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  gitUsername: ''
}

type UpdateRepo = (repoId: string, updates: { terminalTheme: Repo['terminalTheme'] | null }) => void

let rendered: { container: HTMLDivElement; root: Root } | null = null

function renderSection(repo: Repo, updateRepo: UpdateRepo): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(RepositoryTerminalThemeSection, { repo, updateRepo }))
  })
  rendered = { container, root }
  return container
}

function rerenderSection(repo: Repo, updateRepo: UpdateRepo): void {
  act(() => {
    rendered?.root.render(React.createElement(RepositoryTerminalThemeSection, { repo, updateRepo }))
  })
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text
  )
}

function findThemeOption(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.querySelector('span > span')?.textContent === name
  )
}

function click(element: HTMLElement | undefined): void {
  expect(element).toBeDefined()
  act(() => element?.click())
}

afterEach(() => {
  storeState.settings = { ...storeState.defaults }
  act(() => rendered?.root.unmount())
  rendered?.container.remove()
  rendered = null
})

describe('RepositoryTerminalThemeSection', () => {
  it('shows the inherited global theme and no reset when the variant is unset', () => {
    const container = renderSection(baseRepo, vi.fn())

    expect(container.textContent).toContain('Using global: Ghostty Default Style Dark')
    expect(findButton(container, 'Use global')).toBeUndefined()
  })

  it('saves a picked theme as the dark override', () => {
    const updateRepo = vi.fn()
    const container = renderSection(baseRepo, updateRepo)

    click(findThemeOption(container, 'Dracula'))

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { terminalTheme: { dark: 'Dracula' } })
  })

  it('clears the whole override with the null sentinel when the last variant resets', () => {
    const updateRepo = vi.fn()
    const container = renderSection({ ...baseRepo, terminalTheme: { dark: 'Dracula' } }, updateRepo)

    expect(container.textContent).not.toContain('Using global')
    click(findButton(container, 'Use global'))

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { terminalTheme: null })
  })

  it('resets only the light variant on the light target', () => {
    const updateRepo = vi.fn()
    const container = renderSection(
      { ...baseRepo, terminalTheme: { dark: 'Dracula', light: 'Solarized Light' } },
      updateRepo
    )

    click(
      container.querySelector<HTMLButtonElement>('button[role="radio"]:nth-child(2)') ?? undefined
    )
    click(findButton(container, 'Use global'))

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { terminalTheme: { dark: 'Dracula' } })
  })

  it('builds a second pick on the first before the repo prop refreshes', () => {
    const updateRepo = vi.fn(() => new Promise<boolean>(() => {}))
    const container = renderSection(baseRepo, updateRepo)

    click(findThemeOption(container, 'Dracula'))
    click(
      container.querySelector<HTMLButtonElement>('button[role="radio"]:nth-child(2)') ?? undefined
    )
    click(findThemeOption(container, 'Solarized Light'))

    expect(updateRepo).toHaveBeenLastCalledWith('repo-1', {
      terminalTheme: { dark: 'Dracula', light: 'Solarized Light' }
    })
  })

  it('attributes a mirrored light theme to the repo dark override, not the global', () => {
    storeState.settings = { ...storeState.defaults, terminalUseSeparateLightTheme: false }
    const container = renderSection({ ...baseRepo, terminalTheme: { dark: 'Dracula' } }, vi.fn())

    click(
      container.querySelector<HTMLButtonElement>('button[role="radio"]:nth-child(2)') ?? undefined
    )

    expect(container.textContent).toContain("Follows this project's dark theme: Dracula")
    expect(container.textContent).not.toContain('Using global')
    expect(findButton(container, 'Use global')).toBeUndefined()
  })

  it('flags a saved theme that no longer exists and still offers the reset', () => {
    const updateRepo = vi.fn()
    const container = renderSection(
      { ...baseRepo, terminalTheme: { dark: 'custom:warp:gone' } },
      updateRepo
    )

    expect(container.textContent).toContain(
      'Saved theme custom:warp:gone is no longer available. Using global: Ghostty Default Style Dark'
    )
    click(findButton(container, 'Use global'))
    expect(updateRepo).toHaveBeenCalledWith('repo-1', { terminalTheme: null })
  })

  describe('a save the server refuses', () => {
    const FAILED_TEXT = 'Could not save this theme'
    const flush = async (): Promise<void> => {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    it('explains the failure, then clears once a later save succeeds', async () => {
      const updateRepo = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const container = renderSection(baseRepo, updateRepo)

      click(findThemeOption(container, 'Dracula'))
      await flush()
      expect(container.textContent).toContain(FAILED_TEXT)

      click(findThemeOption(container, 'Dracula'))
      expect(container.textContent).not.toContain(FAILED_TEXT)
      await flush()
      expect(container.textContent).not.toContain(FAILED_TEXT)
    })

    it('shows it for a rejected call and keeps it to the project and mode', async () => {
      const updateRepo = vi.fn().mockRejectedValue(new Error('boom'))
      const container = renderSection(baseRepo, updateRepo)
      click(findThemeOption(container, 'Dracula'))
      await flush()
      expect(container.textContent).toContain(FAILED_TEXT)

      click(
        container.querySelector<HTMLButtonElement>('button[role="radio"]:nth-child(2)') ?? undefined
      )
      expect(container.textContent).not.toContain(FAILED_TEXT)
      rerenderSection({ ...baseRepo, id: 'repo-2' }, updateRepo)
      expect(container.textContent).not.toContain(FAILED_TEXT)
    })

    it('drops an older refusal once a newer pick for the project saves', async () => {
      const settles: ((saved: boolean) => void)[] = []
      const updateRepo = vi.fn(() => new Promise<boolean>((resolve) => settles.push(resolve)))
      const container = renderSection(baseRepo, updateRepo)

      click(findThemeOption(container, 'Dracula'))
      click(findThemeOption(container, 'Solarized Dark'))
      settles[0]?.(false)
      await flush()
      expect(container.textContent).not.toContain(FAILED_TEXT)
      settles[1]?.(true)
      await flush()

      expect(settles).toHaveLength(2)
      expect(container.textContent).not.toContain(FAILED_TEXT)
    })

    it('shows only the too-long caption after a refusal and an unstorable pick', async () => {
      const longTheme: TerminalCustomTheme = {
        id: `ghostty:${'x'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH)}`,
        name: 'Long Theme',
        source: 'ghostty',
        mode: 'dark',
        terminal: { background: '#101010', foreground: '#f0f0f0', red: '#ff0000' },
        importedAt: '2026-01-01T00:00:00.000Z'
      }
      storeState.settings = { ...storeState.defaults, terminalCustomThemes: [longTheme] }
      const updateRepo = vi.fn().mockResolvedValue(false)
      const container = renderSection(baseRepo, updateRepo)

      click(findThemeOption(container, 'Dracula'))
      await flush()
      expect(container.textContent).toContain(FAILED_TEXT)

      click(findThemeOption(container, 'Long Theme'))
      expect(container.textContent).toContain('too long to save')
      expect(container.textContent).not.toContain(FAILED_TEXT)
    })

    it('stays quiet when the caller reports success or returns nothing', async () => {
      const updateRepo = vi.fn().mockResolvedValue(true)
      const container = renderSection(baseRepo, updateRepo)
      click(findThemeOption(container, 'Dracula'))
      await flush()
      expect(container.textContent).not.toContain(FAILED_TEXT)
    })
  })

  describe('a pick too long to store', () => {
    const TOO_LONG_TEXT = 'too long to save'
    const longTheme: TerminalCustomTheme = {
      id: `ghostty:${'x'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH)}`,
      name: 'Long Theme',
      source: 'ghostty',
      mode: 'dark',
      terminal: { background: '#101010', foreground: '#f0f0f0', red: '#ff0000' },
      importedAt: '2026-01-01T00:00:00.000Z'
    }
    const radio = (container: HTMLElement, nth: number): HTMLButtonElement | undefined =>
      container.querySelector<HTMLButtonElement>(`button[role="radio"]:nth-child(${nth})`) ??
      undefined

    it('writes nothing, explains why, and clears once a storable pick lands', () => {
      storeState.settings = { ...storeState.defaults, terminalCustomThemes: [longTheme] }
      const updateRepo = vi.fn()
      const container = renderSection(
        { ...baseRepo, terminalTheme: { light: 'Solarized Light' } },
        updateRepo
      )

      click(findThemeOption(container, 'Long Theme'))
      expect(updateRepo).not.toHaveBeenCalled()
      expect(container.textContent).toContain(TOO_LONG_TEXT)

      click(findThemeOption(container, 'Dracula'))
      expect(updateRepo).toHaveBeenCalledWith('repo-1', {
        terminalTheme: { light: 'Solarized Light', dark: 'Dracula' }
      })
      expect(container.textContent).not.toContain(TOO_LONG_TEXT)
    })

    it('keeps the error to the project and mode it happened in', () => {
      storeState.settings = { ...storeState.defaults, terminalCustomThemes: [longTheme] }
      const updateRepo = vi.fn()
      const container = renderSection(baseRepo, updateRepo)
      click(findThemeOption(container, 'Long Theme'))
      expect(container.textContent).toContain(TOO_LONG_TEXT)

      click(radio(container, 2))
      expect(container.textContent).not.toContain(TOO_LONG_TEXT)
      click(radio(container, 1))
      expect(container.textContent).toContain(TOO_LONG_TEXT)

      rerenderSection({ ...baseRepo, id: 'repo-2' }, updateRepo)
      expect(container.textContent).not.toContain(TOO_LONG_TEXT)
      expect(updateRepo).not.toHaveBeenCalled()
    })
  })
})
