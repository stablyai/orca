// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import type { BrowserPasswordEntryDetailsResult } from '../../../../shared/browser-passwords-types'
import { BrowserPasswordManagerDialog } from './BrowserPasswordManagerDialog'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

const api = {
  getStatus: vi.fn(async () => ({ availability: { available: true }, reauthMethod: 'none' })),
  list: vi.fn(async () => [
    { id: 'entry', origin: 'https://example.com', username: 'ada' },
    { id: 'second', origin: 'https://other.test', username: 'grace' }
  ]),
  listNever: vi.fn(async () => []),
  getEntryDetails: vi.fn<() => Promise<BrowserPasswordEntryDetailsResult>>()
}
const profiles: BrowserSessionProfile[] = [
  { id: 'default', label: 'Default', scope: 'default', partition: 'persist:default', source: null },
  { id: 'other', label: 'Other', scope: 'isolated', partition: 'persist:other', source: null }
]

function manager(open: boolean) {
  return (
    <BrowserPasswordManagerDialog
      open={open}
      onOpenChange={() => {}}
      profiles={profiles}
      settings={{}}
      updateSettings={() => {}}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { browserPasswords: api } })
  api.getEntryDetails.mockReset()
})
afterEach(cleanup)

async function settle(): Promise<void> {
  await act(async () => {})
}

async function switchProfile(name: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await settle()
  fireEvent.click(screen.getByRole('option', { name }))
  await settle()
}

describe('password editor request ownership', () => {
  it.each(['reopen', 'profile-round-trip'] as const)(
    'discards an old edit after %s',
    async (transition) => {
      let resolve: (value: BrowserPasswordEntryDetailsResult) => void = () => {}
      api.getEntryDetails.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        })
      )
      const view = render(manager(true))
      await settle()
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit saved password' })[0])
      if (transition === 'reopen') {
        view.rerender(manager(false))
        view.rerender(manager(true))
      } else {
        await switchProfile('Other')
        await switchProfile('Default')
      }
      await act(async () => resolve({ ok: true, password: 'stale-secret', note: '' }))
      expect(screen.queryByDisplayValue('stale-secret')).toBeNull()
      expect(screen.getAllByRole('button', { name: 'Edit saved password' })).toHaveLength(2)
    }
  )

  it('keeps the latest of two competing edit requests', async () => {
    let resolve: (value: BrowserPasswordEntryDetailsResult) => void = () => {}
    api.getEntryDetails.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    api.getEntryDetails.mockResolvedValueOnce({ ok: true, password: 'latest-secret', note: '' })
    render(manager(true))
    await settle()
    const edits = screen.getAllByRole('button', { name: 'Edit saved password' })
    fireEvent.click(edits[0])
    fireEvent.click(edits[1])
    await settle()
    await act(async () => resolve({ ok: true, password: 'stale-secret', note: '' }))
    expect(screen.queryByDisplayValue('stale-secret')).toBeNull()
    expect(screen.getByDisplayValue('latest-secret')).toBeDefined()
  })
})
