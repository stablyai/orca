// @vitest-environment happy-dom

import React, { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { useNativeChatDraft } from './use-native-chat-draft'

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
const settledScopes = new Set<string>()
let releasePending: (() => void) | null = null

/** Suspends the first render of each unseen scope so the sibling probe's render is discarded. */
function SuspendOnNewScope({ scopeKey }: { scopeKey: string }): null {
  if (!settledScopes.has(scopeKey)) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        settledScopes.add(scopeKey)
        resolve()
      }
    })
  }
  return null
}

/** IME stub: never composing. */
const notComposing = (): boolean => false

/** Shows the hook's draft for a scope next to the suspender that discards the render. */
function DraftProbe({ scopeKey }: { scopeKey: string }): React.JSX.Element {
  const { draft } = useNativeChatDraft(scopeKey, notComposing)
  return (
    <>
      <span data-testid="draft">{draft}</span>
      <SuspendOnNewScope scopeKey={scopeKey} />
    </>
  )
}

/** Wraps the probe in the Suspense boundary that a scope change unwinds. */
function boundary(scopeKey: string): React.JSX.Element {
  return (
    <Suspense fallback={<span data-testid="fallback">loading</span>}>
      <DraftProbe scopeKey={scopeKey} />
    </Suspense>
  )
}

beforeEach(() => {
  settledScopes.clear()
  settledScopes.add('pane-a')
  releasePending = null
  clearNativeChatDraftCacheForTests()
})

afterEach(cleanup)

describe('useNativeChatDraft scope switch', () => {
  it('reloads the new pane draft even when the switching render is discarded', async () => {
    writeNativeChatDraftCache('pane-a', 'typed in pane A')
    writeNativeChatDraftCache('pane-b', 'typed in pane B')

    const { rerender } = render(boundary('pane-a'))
    expect(screen.getByTestId('draft').textContent).toBe('typed in pane A')

    rerender(boundary('pane-b'))
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByTestId('draft').textContent).toBe('typed in pane B')
  })
})
