// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscardAllArea } from './discard-all-sequence'
import type { SourceControlEntryGroups } from '../listing/section-order'
import { useSourceControlDiscardConfirmation } from './use-discard-confirmation'

const toastError = vi.fn()
const bulkUnstage = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name] ?? ''))
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-git-client', () => ({
  bulkUnstageRuntimeGitPaths: (...args: unknown[]) => bulkUnstage(...args)
}))

// Electron rethrows a rejected `ipcMain.handle` as `Error invoking remote method '<channel>': <tail>`,
// and `window.api.git.bulkUnstage` / `git.discard` are exactly that. Both discard-all toasts read the
// first retained rejection, so the wrapper reached the description verbatim.
const ENVELOPED =
  "Error invoking remote method 'git:bulkUnstage': Error: fatal: pathspec 'src/app.ts' did not match any file(s) known to git"
const REASON = "fatal: pathspec 'src/app.ts' did not match any file(s) known to git"
const ENVELOPE_ONLY = "Error invoking remote method 'git:bulkUnstage': Error"

function renderDiscard(overrides: {
  discardMany?: (paths: string[]) => Promise<void>
  discardSingle?: (path: string) => Promise<void>
}) {
  return renderHook(() =>
    useSourceControlDiscardConfirmation({
      activeRepoSettings: {} as never,
      activeWorktreeId: 'repo::/w',
      worktreePath: '/w',
      grouped: {} as SourceControlEntryGroups,
      isExecutingBulk: false,
      setIsExecutingBulk: () => {},
      clearSelection: () => {},
      discardMany: overrides.discardMany ?? (async () => {}),
      discardSingle: overrides.discardSingle ?? (async () => {}),
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

// Why: the hook exposes the confirmation dialog, not the handler — this is the real user path.
async function confirmDiscardAll(
  result: { current: ReturnType<typeof useSourceControlDiscardConfirmation> },
  area: DiscardAllArea,
  paths: readonly string[]
): Promise<void> {
  await act(async () => {
    result.current.requestDiscardPaths(area, paths)
  })
  await act(async () => {
    result.current.confirmPendingDiscard()
    await Promise.resolve()
  })
}

describe('the discard-all failure toast', () => {
  beforeEach(() => {
    toastError.mockReset()
    bulkUnstage.mockReset()
  })

  it('shows the reason, not the IPC envelope, when the unstage pre-step rejects', async () => {
    bulkUnstage.mockRejectedValue(new Error(ENVELOPED))
    const { result } = renderDiscard({})

    await confirmDiscardAll(result, 'staged', ['src/app.ts'])

    const description = toastError.mock.calls[0][1].description
    expect(description).toBe(REASON)
    expect(description).not.toContain('Error invoking remote method')
  })

  it('drops the description when the envelope carried no reason', async () => {
    bulkUnstage.mockRejectedValue(new Error(ENVELOPE_ONLY))
    const { result } = renderDiscard({})

    await confirmDiscardAll(result, 'staged', ['src/app.ts'])

    expect(toastError.mock.calls[0][1].description).toBeUndefined()
  })

  it('shows the reason alongside the failed paths when a per-file discard rejects', async () => {
    const { result } = renderDiscard({
      discardMany: async () => {
        throw new Error('no bulk discard on this relay')
      },
      discardSingle: async () => {
        throw new Error(ENVELOPED)
      }
    })

    await confirmDiscardAll(result, 'unstaged', ['src/app.ts'])

    const description = toastError.mock.calls[0][1].description
    expect(description).toBe(`${REASON} (e.g. src/app.ts)`)
    expect(description).not.toContain('Error invoking remote method')
  })
})
