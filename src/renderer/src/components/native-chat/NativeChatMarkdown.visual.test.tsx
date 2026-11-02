// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'
import { clearNativeChatVisualCacheForTests } from './native-chat-visual-read-client'
import { TooltipProvider } from '@/components/ui/tooltip'

const owner: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'session-alpha',
  worktreeId: 'wt-1'
}
const LINE = '::orca-visual{file="usage.html" title="Usage"}'

function withOwner(children: ReactNode, value: NativeChatVisualOwner | null = owner): ReactNode {
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={value}>
        {children}
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

// The transcript mounts a visual once it scrolls near; here every visual is in view at once.
class InViewObserver {
  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', InViewObserver)
  clearNativeChatVisualCacheForTests()
  callRuntimeRpc.mockReset()
  callRuntimeRpc.mockResolvedValue({ ok: true, revision: 'r1', html: '<p>v</p>', path: '/v' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NativeChatMarkdown visuals', () => {
  it('keeps a mounted visual frame while the rest of the reply streams in', async () => {
    const { container, rerender } = render(
      withOwner(
        <NativeChatMarkdown
          content={`Intro\n\n${LINE}\n\n\`\`\`text\nsettled\n\`\`\`\n\nMore`}
          visualMessageId="m1"
          growing
          streaming
        />
      )
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const frame = container.querySelector('iframe')
    rerender(
      withOwner(
        <NativeChatMarkdown
          content={`Intro\n\n${LINE}\n\n\`\`\`text\nsettled\n\`\`\`\n\nMore text arriving now`}
          visualMessageId="m1"
          growing
          streaming
        />
      )
    )
    rerender(
      withOwner(
        <NativeChatMarkdown
          content={`Intro\n\n${LINE}\n\n\`\`\`text\nsettled\n\`\`\`\n\nMore text arriving now\n\n::orca-visual{file="../invalid.html"}\n\nend`}
          visualMessageId="m1"
          growing
          streaming
        />
      )
    )
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container).toHaveTextContent('More text arriving now')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('holds the tail of a text row while its turn works, though the row carries no state', () => {
    const row = (activeTurnIsWorking: boolean, trailingRun = true) =>
      withOwner(
        <MessageRow
          message={{
            id: 'm1',
            role: 'assistant',
            timestamp: 0,
            source: 'transcript',
            blocks: [{ type: 'text', text: 'Here it is:\n::orca-visual{file="usa' }]
          }}
          expandSignal={false}
          activeTurnIsWorking={activeTurnIsWorking}
          trailingRun={trailingRun}
          onScrollMessageToTop={vi.fn()}
        />
      )
    const { container, rerender } = render(row(true))
    expect(container).toHaveTextContent('Here it is:')
    expect(container).not.toHaveTextContent('::orca-visual')
    rerender(row(false))
    expect(container).toHaveTextContent('::orca-visual{file="usa')
    // An earlier row of a still-working turn has stopped growing, so it shows what it says.
    rerender(row(true, false))
    expect(container).toHaveTextContent('::orca-visual{file="usa')
  })
})
