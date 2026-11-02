// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { NativeChatChildTranscriptFrame } from './NativeChatChildTranscriptFrame'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { NativeChatVisualOwnerContext } from './native-chat-visual-owner'
import { clearNativeChatVisualCacheForTests } from './native-chat-visual-read-client'
import type { NativeChatChildTranscriptProps } from './NativeChatChildTranscript'

const reads = vi.hoisted(() => ({ image: vi.fn(), visual: vi.fn() }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview: reads.image }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: reads.visual }))
vi.mock('./NativeChatSessionChildren', () => ({ NativeChatSessionChildren: () => null }))
vi.mock('./NativeChatTranscriptChrome', () => ({
  observeTranscriptVisibility: (_element: Element, onChange: (visible: boolean) => void) => {
    onChange(true)
    return () => {}
  }
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: () => (
    <NativeChatMarkdown
      variant="document"
      content={'![Chart](chart.png)\n\n::orca-visual{file="chart.html" title="Chart"}'}
      visualMessageId="child-message"
    />
  )
}))
const target = { kind: 'environment', environmentId: 'worker-host' } as const
const initial = useAppStore.getInitialState()
const props: NativeChatChildTranscriptProps = {
  child: { agentId: 'worker', label: 'Worker' },
  parent: null,
  onBack: () => {},
  isVisible: true,
  runtimeContext: { target, worktreeId: 'worker-wt', worktreePath: undefined },
  session: {
    agent: 'codex',
    sessionId: 'worker-session',
    status: 'ready',
    readPhase: 'ready',
    messages: [
      { id: 'message', role: 'assistant', timestamp: 1, source: 'transcript', blocks: [] }
    ],
    olderHistoryGeneration: 0,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: async () => 'exhausted'
  }
}
const parentVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'parent',
  worktreeId: 'parent-wt'
} as const
const parentImageOwner = {
  sessionId: 'parent',
  isVisible: true,
  fileLinkContext: {
    worktreeId: 'parent-wt',
    worktreePath: '/parent',
    runtimeEnvironmentId: null
  },
  runtimeContext: {
    target: { kind: 'local' },
    worktreeId: 'parent-wt',
    worktreePath: '/parent'
  }
} as const
function view(knownOwner = true, unavailable?: string) {
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={parentVisualOwner}>
        <NativeChatMarkdownImageOwnerContext.Provider value={parentImageOwner}>
          <NativeChatChildTranscriptFrame
            {...props}
            workerTarget={knownOwner ? target : undefined}
            unavailable={unavailable}
          />
        </NativeChatMarkdownImageOwnerContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({
    worktreesByRepo: {
      repo: [
        makeWorktree({ id: 'worker-wt', repoId: 'repo', path: '/wrong-local', hostId: 'local' }),
        makeWorktree({
          id: 'worker-wt',
          repoId: 'repo',
          path: '/worker',
          hostId: 'runtime:worker-host'
        })
      ]
    }
  })
  resetLocalImageSrcStateForTests()
  clearNativeChatVisualCacheForTests()
  reads.image
    .mockReset()
    .mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  reads.visual.mockReset().mockResolvedValue({
    ok: true,
    revision: 'r1',
    html: '<p>child</p>',
    path: '/worker/chart.html'
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('reads child markdown media on its own host, workspace and session despite parent providers', async () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
  await waitFor(() =>
    expect(reads.image).toHaveBeenCalledWith(
      expect.objectContaining({ target, worktreeId: 'worker-wt', worktreePath: '/worker' }),
      '/worker/chart.png',
      { kind: 'chat-image' }
    )
  )
  await waitFor(() =>
    expect(reads.visual).toHaveBeenCalledWith(
      target,
      'agentSession.readVisual',
      { sessionId: 'worker-session', file: 'chart.html' },
      expect.anything()
    )
  )
})
it.each(['native child without an owner', 'unverifiable worker', 'missing workspace'])(
  'does not borrow parent media for %s',
  async (kind) => {
    if (kind === 'missing workspace') {
      useAppStore.setState({ worktreesByRepo: {} })
    }
    render(
      view(
        kind !== 'native child without an owner',
        kind === 'unverifiable worker' ? 'Worker unavailable' : undefined
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(reads.image).not.toHaveBeenCalled()
    expect(reads.visual).not.toHaveBeenCalled()
  }
)
