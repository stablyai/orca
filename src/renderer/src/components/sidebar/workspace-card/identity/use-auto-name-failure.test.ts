// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BranchAutoRenameDismissResult } from '../../../../../../shared/worktree/branch-auto-rename-attempt'
import { useAutoNameFailure } from './use-auto-name-failure'

const mocks = vi.hoisted(() => {
  const dismissReplies: ((result: BranchAutoRenameDismissResult) => void)[] = []
  return { dismissReplies }
})

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('./branch-auto-rename-actions', () => ({
  canDismissAutoName: () => Promise.resolve(true),
  dismissAutoName: () =>
    new Promise<BranchAutoRenameDismissResult>((resolve) => mocks.dismissReplies.push(resolve)),
  getAutoNameRetryAvailability: () => Promise.resolve({ available: true, runningAttemptId: null }),
  retryAutoName: () => new Promise(() => {}),
  waitForAutoNameAttempt: () => Promise.resolve(null)
}))

type Props = { worktreeId: string; error: string | undefined }
const ERROR = 'Timed out after 30s'

function render(initial: Props) {
  return renderHook((props: Props) => useAutoNameFailure({ ...props, executionHostId: 'local' }), {
    initialProps: initial
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function dismissNow(hook: ReturnType<typeof render>): Promise<void> {
  await settle()
  act(() => hook.result.current?.dismiss())
  await act(async () => mocks.dismissReplies.shift()?.({ dismissed: true }))
}

beforeEach(() => {
  mocks.dismissReplies.length = 0
  Object.assign(window, { api: { worktrees: { onBranchAutoRenameAttempt: () => () => {} } } })
})
afterEach(cleanup)

describe('useAutoNameFailure', () => {
  it('shows the same error again once it has cleared and come back after a dismiss', async () => {
    const hook = render({ worktreeId: 'wt-1', error: ERROR })
    await dismissNow(hook)
    expect(hook.result.current).toBeNull()

    hook.rerender({ worktreeId: 'wt-1', error: undefined })
    hook.rerender({ worktreeId: 'wt-1', error: ERROR })
    expect(hook.result.current).not.toBeNull()
  })

  it('drops a dismiss reply that lands after the row moved to another workspace', async () => {
    const hook = render({ worktreeId: 'wt-1', error: ERROR })
    await settle()
    act(() => hook.result.current?.dismiss())
    expect(hook.result.current?.dismissing).toBe(true)

    hook.rerender({ worktreeId: 'wt-2', error: ERROR })
    await act(async () => mocks.dismissReplies.shift()?.({ dismissed: true }))
    expect(hook.result.current).not.toBeNull()
    expect(hook.result.current?.dismissing).toBe(false)
  })

  it('drops a dismiss reply for an earlier occurrence of the same error', async () => {
    const hook = render({ worktreeId: 'wt-1', error: ERROR })
    await settle()
    act(() => hook.result.current?.dismiss())

    hook.rerender({ worktreeId: 'wt-1', error: undefined })
    hook.rerender({ worktreeId: 'wt-1', error: ERROR })
    await act(async () => mocks.dismissReplies.shift()?.({ dismissed: true }))
    expect(hook.result.current).not.toBeNull()
  })

  it('does not carry Dismiss over to the next workspace before its own check answers', async () => {
    const hook = render({ worktreeId: 'wt-1', error: ERROR })
    await settle()
    expect(hook.result.current?.canDismiss).toBe(true)

    hook.rerender({ worktreeId: 'wt-2', error: ERROR })
    expect(hook.result.current?.canDismiss).toBe(false)
  })
})
