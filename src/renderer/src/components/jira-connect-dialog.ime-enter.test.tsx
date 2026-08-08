// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from './ime-enter-guarded-form.test-events'

const store = vi.hoisted(() => ({
  connectJira: vi.fn(async () => ({ ok: true as const }))
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: { connectJira: typeof store.connectJira; settings: null }) => unknown
  ): unknown => selector({ connectJira: store.connectJira, settings: null })
}))

import { JiraConnectDialog } from './jira-connect-dialog'

function renderDialog(): HTMLInputElement {
  render(<JiraConnectDialog open onOpenChange={() => {}} />)
  fireEvent.change(screen.getByLabelText('Jira Cloud site URL'), {
    target: { value: 'https://example.atlassian.net' }
  })
  fireEvent.change(screen.getByLabelText('Atlassian email'), {
    target: { value: 'developer@example.com' }
  })
  const token = screen.getByLabelText('API token') as HTMLInputElement
  fireEvent.change(token, { target: { value: '한글-token' } })
  return token
}

afterEach(() => {
  cleanup()
  store.connectJira.mockClear()
})

describe('JiraConnectDialog IME implicit submit', () => {
  it('does not connect Jira on the recorded Korean Enter redispatch', () => {
    const input = renderDialog()

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(store.connectJira).not.toHaveBeenCalled()
  })

  it('connects Jira exactly once on an ordinary Enter', () => {
    const input = renderDialog()

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(store.connectJira).toHaveBeenCalledOnce()
  })
})
