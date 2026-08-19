import { describe, expect, it, vi } from 'vitest'
import {
  runSettingsPageLeaveTransaction,
  runSettingsWindowCloseGuard
} from './settings-page-leave-transaction'

type TransactionOverrides = Partial<Parameters<typeof runSettingsPageLeaveTransaction>[0]>

function createTransaction(overrides: TransactionOverrides = {}) {
  return {
    appearanceDirty: true,
    sourceControlDirty: true,
    confirmAppearanceLeave: vi.fn(async () => true),
    confirmSourceControlDiscard: vi.fn(async () => true),
    discardAppearanceDraft: vi.fn(),
    discardSourceControlDrafts: vi.fn(),
    ...overrides
  }
}

describe('settings page leave transaction', () => {
  it('leaves immediately when both drafts are clean', async () => {
    const transaction = createTransaction({ appearanceDirty: false, sourceControlDirty: false })

    await expect(runSettingsPageLeaveTransaction(transaction)).resolves.toBe(true)

    expect(transaction.confirmAppearanceLeave).not.toHaveBeenCalled()
    expect(transaction.confirmSourceControlDiscard).not.toHaveBeenCalled()
    expect(transaction.discardAppearanceDraft).not.toHaveBeenCalled()
    expect(transaction.discardSourceControlDrafts).not.toHaveBeenCalled()
  })

  it('confirms in order and commits both discards after approval', async () => {
    const events: string[] = []
    const transaction = createTransaction({
      confirmAppearanceLeave: vi.fn(async ({ discardDraftOnLeave }) => {
        events.push(`appearance:${discardDraftOnLeave}`)
        return true
      }),
      confirmSourceControlDiscard: vi.fn(async () => {
        events.push('source-control')
        return true
      }),
      discardAppearanceDraft: vi.fn(() => events.push('discard-appearance')),
      discardSourceControlDrafts: vi.fn(() => events.push('discard-source-control'))
    })

    await expect(runSettingsPageLeaveTransaction(transaction)).resolves.toBe(true)

    expect(events).toEqual([
      'appearance:false',
      'source-control',
      'discard-appearance',
      'discard-source-control'
    ])
  })

  it('preserves both drafts when Appearance cancels', async () => {
    const transaction = createTransaction({
      confirmAppearanceLeave: vi.fn(async () => false)
    })

    await expect(runSettingsPageLeaveTransaction(transaction)).resolves.toBe(false)

    expect(transaction.confirmSourceControlDiscard).not.toHaveBeenCalled()
    expect(transaction.discardAppearanceDraft).not.toHaveBeenCalled()
    expect(transaction.discardSourceControlDrafts).not.toHaveBeenCalled()
  })

  it('preserves both drafts when Source Control cancels', async () => {
    const transaction = createTransaction({
      confirmSourceControlDiscard: vi.fn(async () => false)
    })

    await expect(runSettingsPageLeaveTransaction(transaction)).resolves.toBe(false)

    expect(transaction.confirmAppearanceLeave).toHaveBeenCalledWith({ discardDraftOnLeave: false })
    expect(transaction.discardAppearanceDraft).not.toHaveBeenCalled()
    expect(transaction.discardSourceControlDrafts).not.toHaveBeenCalled()
  })

  it.each([
    ['Appearance', true, false, 'discardAppearanceDraft'],
    ['Source Control', false, true, 'discardSourceControlDrafts']
  ] as const)(
    'prompts and discards only the dirty %s draft',
    async (_, appearanceDirty, sourceControlDirty, discardKey) => {
      const transaction = createTransaction({ appearanceDirty, sourceControlDirty })

      await expect(runSettingsPageLeaveTransaction(transaction)).resolves.toBe(true)

      expect(transaction.confirmAppearanceLeave).toHaveBeenCalledTimes(appearanceDirty ? 1 : 0)
      expect(transaction.confirmSourceControlDiscard).toHaveBeenCalledTimes(
        sourceControlDirty ? 1 : 0
      )
      expect(transaction.discardAppearanceDraft).toHaveBeenCalledTimes(
        discardKey === 'discardAppearanceDraft' ? 1 : 0
      )
      expect(transaction.discardSourceControlDrafts).toHaveBeenCalledTimes(
        discardKey === 'discardSourceControlDrafts' ? 1 : 0
      )
    }
  )
})

describe('settings window close guard', () => {
  it('keeps a discarded appearance draft until every downstream close prompt approves', async () => {
    const confirmAppearanceLeave = vi.fn(async () => true)

    await expect(
      runSettingsWindowCloseGuard({
        intentionalRestart: false,
        sourceControlDirty: false,
        confirmAppearanceLeave,
        confirmSourceControlDiscard: vi.fn(async () => true)
      })
    ).resolves.toBe(true)

    expect(confirmAppearanceLeave).toHaveBeenCalledWith({ discardDraftOnLeave: false })
  })

  it('stops before Appearance when Source Control vetoes the close', async () => {
    const confirmAppearanceLeave = vi.fn(async () => true)

    await expect(
      runSettingsWindowCloseGuard({
        intentionalRestart: false,
        sourceControlDirty: true,
        confirmAppearanceLeave,
        confirmSourceControlDiscard: vi.fn(async () => false)
      })
    ).resolves.toBe(false)

    expect(confirmAppearanceLeave).not.toHaveBeenCalled()
  })

  it('bypasses draft prompts during an intentional restart', async () => {
    const confirmAppearanceLeave = vi.fn(async () => false)
    const confirmSourceControlDiscard = vi.fn(async () => false)

    await expect(
      runSettingsWindowCloseGuard({
        intentionalRestart: true,
        sourceControlDirty: true,
        confirmAppearanceLeave,
        confirmSourceControlDiscard
      })
    ).resolves.toBe(true)

    expect(confirmAppearanceLeave).not.toHaveBeenCalled()
    expect(confirmSourceControlDiscard).not.toHaveBeenCalled()
  })
})
