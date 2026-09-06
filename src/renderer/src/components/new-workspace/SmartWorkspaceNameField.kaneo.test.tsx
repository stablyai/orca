// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import SmartWorkspaceNameField from './SmartWorkspaceNameField'
import { lookupKaneoTask } from '@/runtime/runtime-kaneo-client'
import type { KaneoTask } from '../../../../shared/kaneo-types'
vi.mock('@/runtime/runtime-kaneo-client', () => ({ lookupKaneoTask: vi.fn() }))

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
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
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

const url = 'https://tasks.example.com/dashboard/workspace/ws/project/proj/task/task'
const task = { url, title: 'Fix booking', number: 42 } as KaneoTask
function renderKaneoField(onKaneoTaskSelect = vi.fn(), onPlainEnter = vi.fn()) {
  act(() =>
    root.render(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo"
        onRepoChange={vi.fn()}
        value={url}
        onValueChange={vi.fn()}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={vi.fn()}
        onLinearIssueSelect={vi.fn()}
        onKaneoTaskSelect={onKaneoTaskSelect}
        onPlainEnter={onPlainEnter}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
      />
    )
  )
  return container.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')!
}

describe('Kaneo Smart input interaction', () => {
  it('blocks Enter while the URL is unresolved and selects the loaded task', async () => {
    vi.useFakeTimers()
    let resolve!: (task: KaneoTask) => void
    vi.mocked(lookupKaneoTask).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const select = vi.fn()
    const submit = vi.fn()
    const input = renderKaneoField(select, submit)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => input.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    await act(async () => resolve(task))
    expect(container.textContent).toContain('Fix booking')
    expect(input.getAttribute('aria-busy')).toBe('false')
    const taskRow = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Fix booking')
    )!
    act(() => taskRow.click())
    expect(select).toHaveBeenCalledWith(task)
    expect(submit).not.toHaveBeenCalled()
  })

  it('shows an actionable error and never submits the failed URL as a workspace name', async () => {
    vi.useFakeTimers()
    vi.mocked(lookupKaneoTask).mockRejectedValueOnce(new Error('Connect Kaneo in Settings'))
    const submit = vi.fn()
    const input = renderKaneoField(vi.fn(), submit)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.textContent).toContain('Connect Kaneo in Settings')
    expect(container.textContent).toContain('Retry')
    expect(container.textContent).toContain('Open settings')
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    )
    expect(submit).not.toHaveBeenCalled()
  })
})
