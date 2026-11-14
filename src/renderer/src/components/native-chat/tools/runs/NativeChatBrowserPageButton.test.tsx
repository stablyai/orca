// @vitest-environment happy-dom

import { act, render, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../../shared/browser-workspace-types'
import type { NativeChatToolCallBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { setBrowserAgentPageActive } from '../../../browser-pane/agent-cursor/browser-agent-activity-state'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { NativeChatBrowserRunPageButton } from './NativeChatBrowserPageButton'

function page(id: string, title: string): BrowserPage {
  return {
    id,
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    url: `https://example.com/${id}`,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

const state = vi.hoisted((): { browserPagesByWorkspace: Record<string, BrowserPage[]> } => ({
  browserPagesByWorkspace: {}
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (current: typeof state) => unknown) => select(state)
}))

const transcript = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let snapshot: { current: boolean; state: { items: unknown[] } } = {
    current: true,
    state: { items: [] }
  }
  return {
    owner: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    setCalls(calls: readonly NativeChatToolCallBlock[]) {
      snapshot = {
        current: true,
        state: { items: calls.map((call) => ({ body: { ...call, kind: 'tool-call' } })) }
      }
      listeners.forEach((listener) => listener())
    },
    setCurrent(current: boolean) {
      snapshot = { ...snapshot, current }
      listeners.forEach((listener) => listener())
    }
  }
})
vi.mock('../../session/structured/read/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () => transcript.owner
}))

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'session-1',
  worktreeId: 'wt-1'
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}

function browserCall(callId: string, command = 'orca browser click @e1'): NativeChatToolCallBlock {
  return { type: 'tool-call', name: 'Bash', input: { command }, callId }
}

function shownTitle(container: HTMLElement): string | null {
  return within(container).queryByRole('button')?.getAttribute('title') ?? null
}

describe('NativeChatBrowserRunPageButton', () => {
  it("keeps an older run's page after a newer run drives another page", () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'First'), page('p2', 'Second')] }
    const older = browserCall('run-a')
    act(() => transcript.setCalls([older]))
    const olderRun = render(<NativeChatBrowserRunPageButton calls={[older]} />, { wrapper })
    act(() => setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1'))
    expect(shownTitle(olderRun.container)).toBe('First')

    const newer = browserCall('run-b')
    act(() => transcript.setCalls([older, newer]))
    const newerRun = render(<NativeChatBrowserRunPageButton calls={[newer]} />, { wrapper })
    act(() => setBrowserAgentPageActive('p2', true, 'wt-1', undefined, 'session-1'))
    expect(shownTitle(olderRun.container)).toBe('First')
    expect(shownTitle(newerRun.container)).toBe('Second')
  })

  it('ignores other agents driving a different page', () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'Mine'), page('p2', 'Theirs')] }
    const call = browserCall('run-c')
    act(() => transcript.setCalls([call]))
    setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1')
    const { container } = render(<NativeChatBrowserRunPageButton calls={[call]} />, { wrapper })

    act(() => setBrowserAgentPageActive('p2', true, 'wt-1'))
    act(() => setBrowserAgentPageActive('p2', true, 'wt-1', undefined, 'session-2'))
    expect(shownTitle(container)).toBe('Mine')
  })

  it('shows the page for the newest run even when its activity arrived before the run drew', () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'Driven')] }
    const call = browserCall('run-d')
    setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1')
    act(() => transcript.setCalls([call]))
    const { container } = render(<NativeChatBrowserRunPageButton calls={[call]} />, { wrapper })
    expect(shownTitle(container)).toBe('Driven')
  })

  it("never shows another run's page for an older run whose page this renderer never saw", () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'Older'), page('p2', 'Newer')] }
    const older = browserCall('run-restored')
    const newer = browserCall('run-newest')
    act(() => transcript.setCalls([older, newer]))
    setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1')
    const { container } = render(<NativeChatBrowserRunPageButton calls={[older]} />, { wrapper })
    expect(shownTitle(container)).toBeNull()

    act(() => setBrowserAgentPageActive('p2', true, 'wt-1', undefined, 'session-1'))
    expect(shownTitle(container)).toBeNull()
  })

  it('keeps a run off a newer page while the transcript is behind the agent', () => {
    state.browserPagesByWorkspace = { 'ws-1': [page('p1', 'Mine'), page('p2', 'Unseen run')] }
    const call = browserCall('run-e')
    act(() => transcript.setCalls([call]))
    const { container } = render(<NativeChatBrowserRunPageButton calls={[call]} />, { wrapper })
    act(() => setBrowserAgentPageActive('p1', true, 'wt-1', undefined, 'session-1'))

    act(() => transcript.setCurrent(false))
    act(() => setBrowserAgentPageActive('p2', true, 'wt-1', undefined, 'session-1'))
    expect(shownTitle(container)).toBe('Mine')
  })
})
