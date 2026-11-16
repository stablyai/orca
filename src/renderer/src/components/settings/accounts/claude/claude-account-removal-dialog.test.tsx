// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { ClaudeAccountRemovalDialog } from './claude-account-removal-dialog'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

const api = {
  measureRetainedHistory: vi.fn<() => Promise<{ bytes: number }>>(),
  remove: vi.fn(async () => ({ accounts: [] }))
}

function model(): AccountsPaneSectionModel {
  return {
    accountOwner: { kind: 'local' },
    accountRuntimeSentenceLabel: 'this computer',
    claudeAccounts: { accounts: [{ id: 'a', email: 'a@example.test' }] },
    setRemoveClaudeTarget: vi.fn(),
    runClaudeAccountAction: vi.fn(async (_action: string, operation: () => Promise<unknown>) => {
      await operation()
    })
  } as unknown as AccountsPaneSectionModel
}

async function openDialog(): Promise<void> {
  render(
    <ClaudeAccountRemovalDialog
      model={model()}
      target={{ id: 'a', runtime: { runtime: 'host' } }}
    />
  )
  await act(async () => {})
}

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { claudeAccounts: api } })
  api.measureRetainedHistory.mockReset()
  api.remove.mockClear()
})
afterEach(cleanup)

describe('Claude account removal dialog', () => {
  it('keeps conversations unless the user chooses to delete them', async () => {
    api.measureRetainedHistory.mockResolvedValue({ bytes: 3 * 1024 * 1024 })
    await openDialog()
    expect(screen.getByText('3.00 MB')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({ accountId: 'a', deleteRetainedHistory: false })

    cleanup()
    api.remove.mockClear()
    await openDialog()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove account and conversations' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({ accountId: 'a', deleteRetainedHistory: true })
  })

  it('never offers deletion when the size could not be measured, and can retry', async () => {
    api.measureRetainedHistory.mockRejectedValueOnce(new Error('EACCES'))
    await openDialog()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({ accountId: 'a', deleteRetainedHistory: false })

    cleanup()
    api.measureRetainedHistory.mockRejectedValueOnce(new Error('EACCES'))
    api.measureRetainedHistory.mockResolvedValueOnce({ bytes: 512 })
    await openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => {})
    expect(screen.getByText('512 B')).toBeTruthy()
  })
})
