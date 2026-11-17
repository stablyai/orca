// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { usePierreDiffNoteNavigation } from './use-pierre-diff-note-navigation'

const state = vi.hoisted<{
  scrollToDiffCommentId: string | null
  setScrollToDiffCommentId: ReturnType<typeof vi.fn>
}>(() => ({
  scrollToDiffCommentId: 'note',
  setScrollToDiffCommentId: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
const comment: DecoratedDiffComment = {
  id: 'note',
  worktreeId: 'workspace',
  filePath: 'file.ts',
  lineNumber: 500,
  body: 'note',
  createdAt: 0,
  side: 'modified'
}
const props = { worktreeId: 'workspace', filePath: 'file.ts', comments: [comment] }
let host: HTMLElement
let container: HTMLElement
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The navigation seam only uses the two supplied virtual position methods.
const instance = {
  revealLine: vi.fn(() => false),
  getLinePosition: vi.fn(() => ({ top: 1200, height: 20 }))
} as unknown as PierreDiffInstance
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  state.scrollToDiffCommentId = 'note'
  state.setScrollToDiffCommentId.mockImplementation((id) => {
    state.scrollToDiffCommentId = id
  })
  container = document.createElement('div')
  container.className = 'scrollbar-editor'
  host = document.createElement('div')
  container.append(host)
  document.body.append(container)
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 600))
})
afterEach(() => {
  cleanup()
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function addCard() {
  const card = document.createElement('div')
  card.dataset.diffCommentId = 'note'
  host.append(card)
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 1200 - container.scrollTop, 0, 100)
  )
  return card
}

it('centers a laid-out card after cached scroll restoration and acknowledges the jump', () => {
  addCard()
  const { result } = renderHook(() => usePierreDiffNoteNavigation(props))
  act(() => result.current(host, 'mount', instance))
  container.scrollTop = 100
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(950)
  expect(state.setScrollToDiffCommentId).toHaveBeenCalledWith(null)
})

it.each([{ worktreeId: 'another' }, { filePath: 'another.ts' }])(
  'never consumes another surface’s request: %j',
  (update) => {
    addCard()
    const { result } = renderHook(() => usePierreDiffNoteNavigation({ ...props, ...update }))
    act(() => result.current(host, 'mount', instance))
    act(() => vi.runOnlyPendingTimers())
    expect(state.setScrollToDiffCommentId).not.toHaveBeenCalled()
    expect(instance.revealLine).not.toHaveBeenCalled()
  }
)

it('expands hidden context and waits for the virtualized card before acknowledging', () => {
  vi.mocked(instance.revealLine).mockReturnValueOnce(true)
  const { result } = renderHook(() => usePierreDiffNoteNavigation(props))
  act(() => result.current(host, 'mount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(instance.revealLine).toHaveBeenCalledWith(500)
  expect(state.setScrollToDiffCommentId).not.toHaveBeenCalled()
  act(() => result.current(host, 'update', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(instance.getLinePosition).toHaveBeenCalledWith(500, 'additions')
  expect(state.setScrollToDiffCommentId).not.toHaveBeenCalled()
  addCard()
  act(() => result.current(host, 'update', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(state.setScrollToDiffCommentId).toHaveBeenCalledWith(null)
})

it('cancels a queued jump when the view unmounts or the request changes', () => {
  addCard()
  const { result } = renderHook(() => usePierreDiffNoteNavigation(props))
  act(() => result.current(host, 'mount', instance))
  act(() => result.current(host, 'unmount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(state.setScrollToDiffCommentId).not.toHaveBeenCalled()
  act(() => result.current(host, 'mount', instance))
  state.scrollToDiffCommentId = 'new-request'
  act(() => vi.runOnlyPendingTimers())
  expect(state.setScrollToDiffCommentId).not.toHaveBeenCalled()
})
