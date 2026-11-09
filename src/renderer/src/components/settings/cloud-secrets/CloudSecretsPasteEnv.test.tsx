// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSecretBatchResult } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { CloudSecretsPasteEnv } from './CloudSecretsPasteEnv'
import { normalizeSecretName } from './CloudSecretsPasteRow'
import { SecretValueInput } from './SecretValueInput'

const ok = async (): Promise<CloudSecretBatchResult> => ({ secrets: [], deleted: [], errors: [] })

function renderPaste(text: string, onSave = vi.fn(ok)) {
  return render(
    <CloudSecretsPasteEnv
      existingNames={[]}
      onSave={onSave}
      onCancel={vi.fn()}
      initialText={text}
    />
  )
}

function nameInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole('textbox')
    .filter((el): el is HTMLInputElement => el.tagName === 'INPUT')
}

describe('CloudSecretsPasteEnv', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows an unreadable line read-only and rewrites near-miss names', () => {
    renderPaste('sentry-auth-token=abc\noops not a line')
    expect(screen.getByText('Line 2 · skipped')).toBeTruthy()
    // Only the readable line gets a name field.
    expect(nameInputs().map((input) => input.value)).toEqual(['SENTRY_AUTH_TOKEN'])
    expect(screen.getByText(/Renamed from sentry-auth-token/)).toBeTruthy()
    expect(screen.getByText(/1 unreadable line skipped/)).toBeTruthy()
  })

  it('normalizes a typed name and says so', () => {
    renderPaste('A=1')
    fireEvent.change(nameInputs()[0], { target: { value: 'my-api key' } })
    expect(nameInputs()[0].value).toBe('MY_API_KEY')
    expect(screen.getByText(/Spaces and dashes become underscores/)).toBeTruthy()
    expect(normalizeSecretName('db-url')).toBe('DB_URL')
  })

  it('moves focus to the next row on remove, or the previous one for the last row', async () => {
    renderPaste('A=1\nB=2\nC=3')
    fireEvent.click(screen.getByRole('button', { name: 'Leave out A' }))
    await waitFor(() => expect(document.activeElement).toBe(nameInputs()[0]))
    expect(nameInputs()[0].value).toBe('B')
    fireEvent.click(screen.getByRole('button', { name: 'Leave out C' }))
    await waitFor(() => expect(document.activeElement).toBe(nameInputs()[0]))
    expect(nameInputs()[0].value).toBe('B')
  })

  it('focuses the first row that still needs a fix after a partial save', async () => {
    const onSave = vi.fn(async (): Promise<CloudSecretBatchResult> => ({
      secrets: [],
      deleted: [],
      errors: [{ name: 'B', error: 'reserved_name', reason: 'reserved_name' }]
    }))
    renderPaste('A=1\nB=2', onSave)
    fireEvent.click(screen.getByRole('button', { name: /Save 2 secrets/ }))
    await waitFor(() => expect(nameInputs().map((input) => input.value)).toEqual(['B']))
    await waitFor(() => expect(document.activeElement).toBe(nameInputs()[0]))
  })

  it('announces the summary once edits settle', () => {
    vi.useFakeTimers()
    renderPaste('A=1')
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('')
    fireEvent.change(nameInputs()[0], { target: { value: 'AB' } })
    act(() => vi.advanceTimersByTime(300))
    expect(status.textContent).toBe('')
    act(() => vi.advanceTimersByTime(700))
    expect(status.textContent).toBe('1 ready')
  })

  it('tells the user the paste field is paste only', () => {
    renderPaste('')
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toContain('-hint')
    expect(screen.getByText(/Paste only/)).toBeTruthy()
  })
})

describe('SecretValueInput', () => {
  afterEach(cleanup)

  it('re-masks a revealed multi-line value once focus leaves its buttons too', () => {
    render(
      <>
        <SecretValueInput id="v" value={'line 1\nline 2'} onChange={vi.fn()} />
        <button type="button">elsewhere</button>
      </>
    )
    const show = screen.getByRole('button', { name: 'Show value' })
    fireEvent.click(show)
    expect(screen.getByDisplayValue(/line 1/).tagName).toBe('TEXTAREA')
    const hide = screen.getByRole('button', { name: 'Hide value' })
    fireEvent.blur(hide, { relatedTarget: screen.getByText('elsewhere') })
    expect(screen.queryByDisplayValue(/line 1/)).toBeNull()
    expect(screen.getByDisplayValue(/Multi-line value · 2 lines/)).toBeTruthy()
  })
})
