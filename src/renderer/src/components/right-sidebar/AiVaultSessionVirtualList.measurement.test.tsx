// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'

function makeSession(index: number): AiVaultSession {
  return {
    id: `local:omp:session-${index}:/tmp/session-${index}.jsonl`,
    executionHostId: 'local',
    agent: 'omp',
    sessionId: `session-${index}`,
    title: `Session ${index}`,
    cwd: '/repo',
    branch: null,
    model: 'gpt-5',
    filePath: `/tmp/session-${index}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 10,
    totalTokens: 0,
    previewMessages: [{ role: 'assistant', text: `Reply ${index}`, timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `omp resume session-${index}`,
    subagent: null
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderList(sessions: AiVaultSession[], loading = false) {
  return render(
    <TooltipProvider>
      <AiVaultSessionVirtualList
        groups={[{ key: 'live_studio_mono', label: 'live_studio_mono', sessions }]}
        collapsedGroups={new Set()}
        loading={loading}
        sessionsCount={sessions.length}
        filteredSessionsCount={sessions.length}
        noAgentsSelected={false}
        error={null}
        vaultScope="workspace"
        buildResumeStartup={(session) => ({ command: session.resumeCommand })}
        getOriginalPaneTarget={() => null}
        isStructuredSessionOpen={() => false}
        getSessionLiveState={() => null}
        getWorktreeInfo={() => null}
        getSessionResumeState={() => ({
          blocked: false,
          worktreeId: 'worktree-1',
          usesSessionWorktree: false
        })}
        getSessionResumeActions={() => ({
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: 'worktree-1', disabled: false }
        })}
        getSessionResumeInChat={() => ({ available: false, reason: 'already-structured' })}
        onToggleGroup={vi.fn()}
        onJumpToOriginalPane={vi.fn()}
        onJumpToWorktree={vi.fn()}
        onResume={vi.fn()}
        onContinueInNewSession={vi.fn()}
        onResumeInNewChat={vi.fn()}
        onResumeInNewCli={vi.fn()}
        onCopyResume={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenLog={vi.fn()}
        onRevealLog={vi.fn()}
        onOpenCwd={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('AiVaultSessionVirtualList row measurement', () => {
  it('keeps measured offsets while hidden and accepts positive sizes after restore', () => {
    const observers = new Map<
      ResizeObserver,
      {
        callback: ResizeObserverCallback
        targets: Set<Element>
      }
    >()
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observers.set(this, { callback, targets: new Set() })
      }
      observe(target: Element): void {
        observers.get(this)?.targets.add(target)
      }
      unobserve(target: Element): void {
        observers.get(this)?.targets.delete(target)
      }
      disconnect(): void {
        observers.delete(this)
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.stubGlobal('api', { aiVault: {} })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('overflow-y-auto')) {
        return 600
      }
      return this.getAttribute('data-index') === '0' ? 32 : 98
    })
    const { container, getByText } = renderList([makeSession(1), makeSession(2), makeSession(3)])
    const first = container.querySelector<HTMLElement>('[data-index="1"]')
    const second = container.querySelector<HTMLElement>('[data-index="2"]')
    if (!first || !second) {
      throw new Error('Expected session rows to render')
    }
    const resize = (element: Element, height: number): void => {
      act(() => {
        for (const [observer, { callback, targets }] of observers) {
          if (!targets.has(element)) {
            continue
          }
          const size = [{ blockSize: height, inlineSize: 440 }]
          callback(
            [
              {
                target: element,
                borderBoxSize: size,
                contentBoxSize: size,
                devicePixelContentBoxSize: size,
                contentRect: element.getBoundingClientRect()
              }
            ],
            observer
          )
        }
      })
    }

    expect(second.style.transform).toBe('translateY(130px)')
    resize(first, 117)
    expect(second.style.transform).toBe('translateY(149px)')

    fireEvent.click(getByText('Session 1'))
    resize(first, 669)
    expect(second.style.transform).toBe('translateY(701px)')
    const scroller = container.querySelector<HTMLElement>('.overflow-y-auto')
    if (!scroller) {
      throw new Error('Expected scroll viewport')
    }
    const hiddenRects = scroller.getClientRects()
    Array.prototype.splice.call(hiddenRects, 0, hiddenRects.length)
    const layoutBox = vi.spyOn(scroller, 'getClientRects').mockReturnValue(hiddenRects)
    resize(first, 0)
    expect(second.style.transform).toBe('translateY(701px)')
    layoutBox.mockRestore()
    resize(first, 720)
    expect(second.style.transform).toBe('translateY(752px)')

    fireEvent.click(getByText('Session 1'))
    resize(first, 117)
    expect(second.style.transform).toBe('translateY(149px)')
    const collapsedLayoutBox = vi.spyOn(scroller, 'getClientRects').mockReturnValue(hiddenRects)
    resize(first, 0)
    expect(second.style.transform).toBe('translateY(149px)')
    collapsedLayoutBox.mockRestore()
    resize(first, 135)
    expect(second.style.transform).toBe('translateY(167px)')
  })
})
