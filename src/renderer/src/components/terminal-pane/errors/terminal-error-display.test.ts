import { describe, expect, it } from 'vitest'
import { isReattachRetryError } from './terminal-error-display'

describe('Retry eligibility for accumulated pane errors', () => {
  // GH1297: one pane's Retries can stack refusals from both recoverable families.
  it.each([
    ['an owner refusal', 'terminal_pane_owner_unverified'],
    ['a history refusal', 'terminal_history_unavailable'],
    ['a refusal before a fresh start', 'terminal_history_unavailable_before_start'],
    [
      'an owner refusal then a history refusal',
      'terminal_pane_owner_unverified\nterminal_history_unavailable'
    ],
    [
      'an owner refusal then a refusal before a fresh start',
      'terminal_pane_owner_changed\nterminal_history_unavailable_before_start'
    ]
  ])('keeps Retry for %s', (_, error) => {
    expect(isReattachRetryError(error)).toBe(true)
  })

  it.each([
    ['nothing', ''],
    ['an unrelated failure', 'spawn failed: no such shell'],
    [
      'recoverable refusals beside an unrelated failure',
      'terminal_pane_owner_unverified\nterminal_history_unavailable\nspawn failed: no such shell'
    ]
  ])('offers no Retry for %s', (_, error) => {
    expect(isReattachRetryError(error)).toBe(false)
  })
})
