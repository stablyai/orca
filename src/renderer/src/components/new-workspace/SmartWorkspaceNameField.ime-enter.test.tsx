// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import SmartWorkspaceNameField from './SmartWorkspaceNameField'

vi.mock('@/store', () => {
  const state = {
    repos: [],
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    fetchLinearIssue: vi.fn(),
    fetchWorkItems: vi.fn(),
    fetchWorkItemsAcrossRepos: vi.fn(),
    getCachedWorkItems: vi.fn(() => null),
    linearStatus: { connected: false },
    linearStatusChecked: false,
    listLinearIssues: vi.fn(),
    preflightStatus: null,
    preflightStatusChecked: false,
    preflightStatusContextKey: null,
    refreshPreflightStatus: vi.fn(),
    searchLinearIssues: vi.fn(),
    settings: null
  }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  useAppStore.setState = (patch: Partial<typeof state>) => Object.assign(state, patch)
  return { useAppStore }
})

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test-preflight-context'
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useAppStore.setState({
    linearStatus: { connected: false, viewer: null },
    linearStatusChecked: false,
    fetchLinearIssue: vi.fn(async () => null),
    listLinearIssues: vi.fn(async () => ({ items: [] })),
    searchLinearIssues: vi.fn(async () => [])
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  vi.useRealTimers()
  container.remove()
})

function renderField(onPlainEnter: () => void): HTMLInputElement {
  act(() => {
    root.render(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo-1"
        onRepoChange={vi.fn()}
        value="배포"
        onValueChange={vi.fn()}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={vi.fn()}
        onLinearIssueSelect={vi.fn()}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
        onPlainEnter={onPlainEnter}
        textOnly
      />
    )
  })
  const input = container.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
  if (!input) {
    throw new Error('workspace name input not rendered')
  }
  return input
}

function renderSmartField(spies: {
  onValueChange: () => void
  onBranchSelect: () => void
  onPlainEnter: () => void
}): HTMLInputElement {
  act(() => {
    root.render(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo-1"
        onRepoChange={vi.fn()}
        value="배포"
        onValueChange={spies.onValueChange}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={spies.onBranchSelect}
        onLinearIssueSelect={vi.fn()}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
        onPlainEnter={spies.onPlainEnter}
      />
    )
  })
  const input = container.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
  if (!input) {
    throw new Error('workspace name input not rendered')
  }
  return input
}

function renderEmojiField(value: string, onValueChange: (value: string) => void): HTMLInputElement {
  act(() => {
    root.render(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo-1"
        onRepoChange={vi.fn()}
        value={value}
        onValueChange={onValueChange}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={vi.fn()}
        onLinearIssueSelect={vi.fn()}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
        textOnly
      />
    )
  })
  const input = container.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
  if (!input) {
    throw new Error('workspace name input not rendered')
  }
  return input
}

// Why: the guard must short-circuit before the `open && rows.length > 0`
// row-select branch, so drive the field into that state — smart mode with a
// typed value synchronously yields a highlighted "use this name" row.
function openSourcePopover(input: HTMLInputElement): void {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  act(() => {
    input.dispatchEvent(event)
  })
}

function pressEnter(
  input: HTMLInputElement,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

describe('SmartWorkspaceNameField IME Enter guard', () => {
  it('ignores the Enter that commits a CJK IME composition (isComposing)', () => {
    const onPlainEnter = vi.fn()
    const input = renderField(onPlainEnter)

    pressEnter(input, { isComposing: true })

    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('ignores the Enter reported as keyCode 229 by IMEs that skip isComposing', () => {
    const onPlainEnter = vi.fn()
    const input = renderField(onPlainEnter)

    pressEnter(input, { keyCode: 229 })

    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('still forwards a plain Enter to onPlainEnter', () => {
    const onPlainEnter = vi.fn()
    const input = renderField(onPlainEnter)

    pressEnter(input)

    expect(onPlainEnter).toHaveBeenCalledTimes(1)
  })

  it('does not select the highlighted source row on an IME-composition Enter', () => {
    const onValueChange = vi.fn()
    const onBranchSelect = vi.fn()
    const onPlainEnter = vi.fn()
    const input = renderSmartField({ onValueChange, onBranchSelect, onPlainEnter })
    openSourcePopover(input)

    pressEnter(input, { isComposing: true })

    // The guard runs before the row-select branch, so neither the row commit
    // (onValueChange) nor the fall-through (onPlainEnter) should fire.
    expect(onValueChange).not.toHaveBeenCalled()
    expect(onBranchSelect).not.toHaveBeenCalled()
    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('selects the highlighted source row on a plain Enter (control for the guard)', () => {
    const onValueChange = vi.fn()
    const onBranchSelect = vi.fn()
    const onPlainEnter = vi.fn()
    const input = renderSmartField({ onValueChange, onBranchSelect, onPlainEnter })
    openSourcePopover(input)

    pressEnter(input)

    // With the popover open and a highlighted "use this name" row, a plain
    // Enter commits that row (onValueChange) and does NOT fall through to
    // onPlainEnter — proving the composition case above was really suppressed
    // at the row-select branch, not merely inert.
    expect(onValueChange).toHaveBeenCalledWith('배포')
    expect(onPlainEnter).not.toHaveBeenCalled()
  })
})

describe('SmartWorkspaceNameField Linear URL loading', () => {
  it('blocks Enter and delays visible loading feedback while preserving its layout', async () => {
    vi.useFakeTimers()
    const url = 'https://linear.app/stably/issue/STA-4084/restore-shell-integration'
    const onPlainEnter = vi.fn()
    const onValueChange = vi.fn()
    const onLinearIssueSelect = vi.fn()
    useAppStore.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        activeWorkspaceId: 'workspace-1',
        selectedWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            displayName: 'Stably User',
            email: null,
            organizationId: 'organization-stably',
            organizationName: 'Stably',
            organizationUrlKey: 'stably'
          }
        ]
      },
      linearStatusChecked: true,
      fetchLinearIssue: vi.fn(() => new Promise<null>(() => {}))
    })

    await act(async () => {
      root.render(
        <SmartWorkspaceNameField
          repos={[]}
          repoId="repo-1"
          onRepoChange={vi.fn()}
          value={url}
          onValueChange={onValueChange}
          onGitHubItemSelect={vi.fn()}
          onBranchSelect={vi.fn()}
          onLinearIssueSelect={onLinearIssueSelect}
          selectedSource={null}
          onClearSelectedSource={vi.fn()}
          onPlainEnter={onPlainEnter}
        />
      )
    })

    const input = container.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
    const describedBy = input?.getAttribute('aria-describedby')
    const status = describedBy ? container.querySelector<HTMLElement>(`#${describedBy}`) : null
    const reservedResults = container.querySelector<HTMLElement>('[aria-hidden="true"].space-y-1')
    expect(input?.getAttribute('aria-busy')).toBe('true')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toContain('Loading Linear issue…')
    expect(container.textContent).not.toContain('Start typing to create a name or find a source.')
    expect(reservedResults?.classList.contains('invisible')).toBe(true)
    expect(reservedResults?.children).toHaveLength(3)

    if (!input) {
      throw new Error('workspace name input not rendered')
    }
    pressEnter(input)
    expect(onPlainEnter).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(onLinearIssueSelect).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199)
    })
    expect(reservedResults?.classList.contains('invisible')).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    const visibleResults = container.querySelector<HTMLElement>('[aria-hidden="true"].space-y-1')
    expect(visibleResults).toBe(reservedResults)
    expect(visibleResults?.classList.contains('invisible')).toBe(false)
    expect(visibleResults?.querySelectorAll('.animate-pulse')).toHaveLength(3)
  })
})

describe('SmartWorkspaceNameField emoji shortcodes', () => {
  it('replaces a completed shortcode as it is typed', () => {
    const onValueChange = vi.fn()
    const input = renderEmojiField('Launch ', onValueChange)

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Launch :wink: experiment'
      )
      input.setSelectionRange(13, 13)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })

    expect(onValueChange).toHaveBeenCalledWith('Launch 😉 experiment')
  })

  it('accepts the highlighted shortcode suggestion with Enter', () => {
    const onValueChange = vi.fn()
    const input = renderEmojiField('Launch :wink', onValueChange)

    act(() => {
      input.focus()
      input.setSelectionRange(12, 12)
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    pressEnter(input)

    expect(onValueChange).toHaveBeenCalledWith('Launch 😉 ')
  })
})
