// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useVirtualizer, Virtualizer } from '@tanstack/react-virtual'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactVirtual>()
  return { ...actual, useVirtualizer: vi.fn(actual.useVirtualizer) }
})

const resizeObservers = new Set<TestResizeObserver>()

class TestResizeObserver implements ResizeObserver {
  readonly elements = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this)
  }
  observe(element: Element): void {
    this.elements.add(element)
  }
  unobserve(element: Element): void {
    this.elements.delete(element)
  }
  disconnect(): void {
    this.elements.clear()
    resizeObservers.delete(this)
  }
}

function resizeEntry(element: HTMLElement, height: number): ResizeObserverEntry {
  const size = { blockSize: height, inlineSize: 300 }
  return {
    target: element,
    contentRect: new DOMRect(0, 0, 300, height),
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size]
  }
}

beforeEach(() => {
  vi.mocked(useVirtualizer).mockClear()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('api', { aiVault: {} })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('overflow-y-auto')) {
      return 300
    }
    return this.getAttribute('data-vault-virtual-row-key')?.startsWith('group:') ? 32 : 98
  })
})

afterEach(() => {
  cleanup()
  resizeObservers.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function vaultSession(index: number, cwd = '/repo'): AiVaultSession {
  return {
    id: `local:codex:s${index}:/path/s${index}.jsonl`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: `s${index}`,
    title: `Session ${index}`,
    cwd,
    branch: null,
    model: null,
    filePath: `/path/s${index}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-20T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 100,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume s${index}`,
    subagent: null
  }
}

const sessions = Array.from({ length: 40 }, (_, index) => vaultSession(index))
type ListProps = ComponentProps<typeof AiVaultSessionVirtualList>

function listProps(overrides: Partial<ListProps> = {}): ListProps {
  return {
    groups: [{ key: 'search-results', label: null, sessions }],
    collapsedGroups: new Set(),
    loading: false,
    sessionsCount: sessions.length,
    filteredSessionsCount: sessions.length,
    noAgentsSelected: false,
    error: null,
    vaultScope: 'all',
    buildResumeStartup: () => ({ command: '' }),
    getOriginalPaneTarget: () => null,
    isStructuredSessionOpen: () => false,
    getSessionLiveState: () => null,
    getWorktreeInfo: () => null,
    getSessionResumeState: () => ({ blocked: false, worktreeId: null, usesSessionWorktree: false }),
    getSessionResumeActions: () => ({
      worktree: { worktreeId: null, disabled: true },
      newTab: { worktreeId: null, disabled: true }
    }),
    getSessionResumeInChat: () => ({ available: false, reason: 'already-structured' }),
    onToggleGroup: vi.fn(),
    onJumpToOriginalPane: vi.fn(),
    onJumpToWorktree: vi.fn(),
    onResume: vi.fn(),
    onContinueInNewSession: vi.fn(),
    onResumeInNewChat: vi.fn(),
    onResumeInNewCli: vi.fn(),
    onCopyResume: vi.fn(),
    onCopyId: vi.fn(),
    onCopyPath: vi.fn(),
    onOpenLog: vi.fn(),
    onRevealLog: vi.fn(),
    onOpenCwd: vi.fn(),
    onRequestDelete: vi.fn(),
    ...overrides
  }
}

function list(props: ListProps, key = 'history') {
  return (
    <TooltipProvider>
      <AiVaultSessionVirtualList key={key} {...props} />
    </TooltipProvider>
  )
}

function currentVirtualizer() {
  const instance = vi.mocked(useVirtualizer).mock.results.at(-1)?.value
  if (!(instance instanceof Virtualizer)) {
    throw new Error('Expected the real virtualizer instance')
  }
  return instance
}

it('keeps header spacing at 32px through resize reports and sticky handoff', () => {
  const groups = [
    { key: 'folder:/repo', label: 'repo', sessions: sessions.slice(0, 4) },
    { key: 'folder:/other', label: 'other', sessions: sessions.slice(4, 8) }
  ]
  const { container } = render(
    list(listProps({ groups, sessionsCount: 8, filteredSessionsCount: 8 }))
  )
  const scroller = container.querySelector<HTMLElement>('.overflow-y-auto')
  if (!scroller) {
    throw new Error('Expected the list scroller')
  }
  const headers = [
    ...container.querySelectorAll<HTMLElement>('[data-vault-virtual-row-key^="group:"]')
  ]
  expect(headers).toHaveLength(2)
  const secondGroupStart = 32 + 4 * 98
  const totalHeight = 2 * secondGroupStart
  for (const scrollOffset of [0, secondGroupStart]) {
    scroller.scrollTop = scrollOffset
    fireEvent.scroll(scroller)
    for (const [index, header] of headers.entries()) {
      expect(header.classList.contains('sticky')).toBe(index === (scrollOffset === 0 ? 0 : 1))
      expect([...resizeObservers].some((observer) => observer.elements.has(header))).toBe(true)
    }
    for (const height of [64, 0, 48]) {
      act(() => {
        for (const observer of resizeObservers) {
          const entries = headers
            .filter((header) => observer.elements.has(header))
            .map((header) => resizeEntry(header, height))
          observer.callback(entries, observer)
        }
      })
      const virtualizer = currentVirtualizer()
      const items = virtualizer.getVirtualItems()
      expect(items.find((item) => item.index === 0)?.size).toBe(32)
      expect(items.find((item) => item.index === 1)?.start).toBe(32)
      expect(items.find((item) => item.index === 5)?.size).toBe(32)
      expect(items.find((item) => item.index === 6)?.start).toBe(secondGroupStart + 32)
      expect(virtualizer.getTotalSize()).toBe(totalHeight)
      expect(container.querySelector<HTMLElement>('.relative')?.style.height).toBe(
        `${totalHeight}px`
      )
    }
  }
})

it('preserves an expanded offscreen height when rejecting a connected stale row', () => {
  const { container } = render(list(listProps()))
  const scroller = container.querySelector<HTMLElement>('.overflow-y-auto')
  if (!scroller) {
    throw new Error('Expected the list scroller')
  }
  scroller.scrollTop = 30 * 98
  fireEvent.scroll(scroller)
  fireEvent.click(screen.getByText('Session 30'))
  const expandedRow = screen.getByText('Session 30').closest('[data-index]')
  if (!(expandedRow instanceof HTMLElement)) {
    throw new Error('Expected the expanded row')
  }
  act(() => {
    for (const observer of resizeObservers) {
      if (observer.elements.has(expandedRow)) {
        observer.callback([resizeEntry(expandedRow, 700)], observer)
      }
    }
  })
  scroller.scrollTop = 0
  fireEvent.scroll(scroller)
  const virtualizer = currentVirtualizer()
  expect(virtualizer.getVirtualItems().some((item) => item.index === 30)).toBe(false)
  const before = virtualizer.getTotalSize()
  const stale = document.createElement('div')
  stale.setAttribute('data-index', '30')
  stale.setAttribute('data-vault-virtual-row-key', 'session:old-row')
  container.appendChild(stale)

  const returned = virtualizer.options.measureElement(stale, resizeEntry(stale, 0), virtualizer)
  act(() => virtualizer.resizeItem(30, returned))

  expect(returned).toBe(700)
  expect(virtualizer.getTotalSize()).toBe(before)
  expect(container.querySelector<HTMLElement>('.relative')?.style.height).toBe(`${before}px`)
})

it('removes All rows and height when switching to a collapsed workspace despite queued resizes', () => {
  const workspaceGroup = { key: 'folder:/repo', label: 'repo', sessions: [vaultSession(0)] }
  const otherGroup = {
    key: 'folder:/other',
    label: 'other',
    sessions: sessions.slice(1).map((session) => ({ ...session, cwd: '/other' }))
  }
  const all = listProps({ groups: [workspaceGroup, otherGroup] })
  const { container, rerender } = render(list(all, 'all'))
  const scroller = container.querySelector<HTMLElement>('.overflow-y-auto')
  if (!scroller) {
    throw new Error('Expected the list scroller')
  }
  scroller.scrollTop = 3000
  fireEvent.scroll(scroller)
  expect(screen.queryByText('Session 0')).toBeNull()
  const oldRows = [...container.querySelectorAll<HTMLElement>('[data-index]')]
  const queued = [...resizeObservers].map((observer) => ({
    observer,
    entries: oldRows.filter((row) => observer.elements.has(row)).map((row) => resizeEntry(row, 0))
  }))

  rerender(
    list(
      listProps({
        groups: [workspaceGroup],
        vaultScope: 'workspace',
        filteredSessionsCount: 1,
        collapsedGroups: new Set([workspaceGroup.key])
      }),
      'workspace'
    )
  )
  act(() => {
    for (const { observer, entries } of queued) {
      observer.callback(entries, observer)
    }
  })

  expect(screen.queryAllByText(/^Session \d+$/)).toHaveLength(0)
  expect(screen.queryByText('other')).toBeNull()
  expect(screen.getByRole('button', { name: /repo/ }).getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector<HTMLElement>('.relative')?.style.height).toBe('32px')
  expect(container.querySelector<HTMLElement>('.overflow-y-auto')?.scrollTop).toBe(0)
  expect(oldRows.every((row) => !row.isConnected)).toBe(true)
})
