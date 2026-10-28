// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPasswordEntryDetailsResult } from '../../../../shared/browser-passwords-types'
import { BrowserPasswordsSection } from './BrowserPasswordsSection'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('./BrowserPasswordImportMenu', () => ({ BrowserPasswordImportMenu: () => null }))

const api = {
  getStatus: vi.fn(async () => ({ availability: { available: true }, reauthMethod: 'none' })),
  list: vi.fn(async () => [
    { id: 'entry', origin: 'https://example.com', username: 'ada', lastUsedAt: null },
    { id: 'second', origin: 'https://other.test', username: 'grace', lastUsedAt: null }
  ]),
  listNever: vi.fn(async () => []),
  getEntryDetails: vi.fn<() => Promise<BrowserPasswordEntryDetailsResult>>()
}

function section(browserProfileId: string) {
  return (
    <BrowserPasswordsSection
      browserProfileId={browserProfileId}
      profileLabel={browserProfileId}
      settings={{}}
      updateSettings={() => {}}
    />
  )
}

function editButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: /^Edit / })
}

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { browserPasswords: api } })
  api.getEntryDetails.mockReset()
})
afterEach(cleanup)

async function settle(): Promise<void> {
  await act(async () => {})
}

function pendingDetails(): (value: BrowserPasswordEntryDetailsResult) => void {
  let resolve: (value: BrowserPasswordEntryDetailsResult) => void = () => {}
  api.getEntryDetails.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  return (value) => resolve(value)
}

describe('password editor request ownership', () => {
  it('keeps the latest of two competing edit requests', async () => {
    const resolve = pendingDetails()
    api.getEntryDetails.mockResolvedValueOnce({ ok: true, password: 'latest-secret', note: '' })
    render(section('default'))
    await settle()
    const edits = editButtons()
    fireEvent.click(edits[0])
    fireEvent.click(edits[1])
    await settle()
    await act(async () => resolve({ ok: true, password: 'stale-secret', note: '' }))
    expect(screen.queryByDisplayValue('stale-secret')).toBeNull()
    expect(screen.getByDisplayValue('latest-secret')).toBeDefined()
  })
})
