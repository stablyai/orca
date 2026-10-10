// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatVisualReadOutcome } from './native-chat-visual-read-client'

const read = vi.hoisted((): { next: NativeChatVisualReadOutcome; calls: number } => ({
  next: { ok: true, document: { revision: 'r1', html: '<p>first</p>' } },
  calls: 0
}))

vi.mock('./native-chat-visual-read-client', () => ({
  peekCachedNativeChatVisual: () => null,
  isRetryableNativeChatVisualFailure: () => false,
  readNativeChatVisual: async () => {
    read.calls += 1
    return read.next
  }
}))

import { NativeChatVisualTab } from './NativeChatVisualTab'

const visual = {
  target: { kind: 'local' as const },
  sessionId: 'session-1',
  file: 'latency.html',
  title: 'Latency'
}

afterEach(cleanup)

describe('NativeChatVisualTab', () => {
  it('re-reads an open tab when the visual is opened again, not on an unrelated rerender', async () => {
    const view = render(<NativeChatVisualTab visual={visual} />)
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
    view.rerender(<NativeChatVisualTab visual={visual} />)
    expect(read.calls).toBe(1)

    read.next = { ok: true, document: { revision: 'r2', html: '<p>second</p>' } }
    view.rerender(<NativeChatVisualTab visual={{ ...visual, title: 'Latency (p99)' }} />)

    await waitFor(() =>
      expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain(
        '<p>second</p>'
      )
    )
    expect(read.calls).toBe(2)
  })
})
