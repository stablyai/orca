// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
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

function model(): ComponentProps<typeof ClaudeAccountRemovalDialog>['model'] {
  return {
    accountOwner: { kind: 'local' },
    accountRuntimeSentenceLabel: 'this computer',
    claudeAccounts: { accounts: [{ id: 'a', email: 'a@example.test' }] },
    setRemoveClaudeTarget: vi.fn(),
    runClaudeAccountAction: vi.fn(async (_action: string, operation: () => Promise<unknown>) => {
      await operation()
    })
  }
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
    expect(api.remove).toHaveBeenCalledWith({
      accountId: 'a',
      deleteRetainedHistory: false,
      hostDeletesHistory: false
    })

    cleanup()
    api.remove.mockClear()
    await openDialog()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove account and conversations' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({
      accountId: 'a',
      deleteRetainedHistory: true,
      hostDeletesHistory: false
    })
  })

  it('starts each opening over at keep, with a fresh size', async () => {
    api.measureRetainedHistory.mockResolvedValueOnce({ bytes: 512 })
    api.measureRetainedHistory.mockResolvedValueOnce({ bytes: 2048 })
    const props = { model: model() }
    const view = render(
      <ClaudeAccountRemovalDialog {...props} target={{ id: 'a', runtime: { runtime: 'host' } }} />
    )
    await act(async () => {})
    fireEvent.click(screen.getByRole('checkbox'))
    view.rerender(<ClaudeAccountRemovalDialog {...props} target={null} />)
    view.rerender(
      <ClaudeAccountRemovalDialog {...props} target={{ id: 'a', runtime: { runtime: 'host' } }} />
    )
    await act(async () => {})
    expect(screen.getByText('2.00 KB')).toBeTruthy()
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
  })

  it('says an older host deletes the conversations, and removes the old way there', async () => {
    api.measureRetainedHistory.mockRejectedValueOnce(
      Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
    )
    await openDialog()
    expect(
      screen.getByText(
        'Orca on this computer also deletes the conversations kept only for this account. Update Orca there to keep them.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({
      accountId: 'a',
      deleteRetainedHistory: false,
      hostDeletesHistory: true
    })
  })

  it('never offers deletion when the size could not be measured, and can retry', async () => {
    api.measureRetainedHistory.mockRejectedValueOnce(new Error('EACCES'))
    await openDialog()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    await act(async () => {})
    expect(api.remove).toHaveBeenCalledWith({
      accountId: 'a',
      deleteRetainedHistory: false,
      hostDeletesHistory: false
    })

    cleanup()
    api.measureRetainedHistory.mockRejectedValueOnce(new Error('EACCES'))
    api.measureRetainedHistory.mockResolvedValueOnce({ bytes: 512 })
    await openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => {})
    expect(screen.getByText('512 B')).toBeTruthy()
  })
})
