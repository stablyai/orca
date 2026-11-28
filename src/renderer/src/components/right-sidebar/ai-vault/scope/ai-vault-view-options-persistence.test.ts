import { expect, it } from 'vitest'
import {
  AI_VAULT_PINNED_SESSIONS_MAX,
  normalizeAiVaultViewOptions
} from './ai-vault-view-options-persistence'

it('keeps only unique string pins, newest first, capped', () => {
  const overCap = Array.from({ length: AI_VAULT_PINNED_SESSIONS_MAX + 5 }, (_, i) => `pin-${i}`)
  expect(normalizeAiVaultViewOptions({ pinnedSessions: overCap }).pinnedSessions).toEqual(
    overCap.slice(0, AI_VAULT_PINNED_SESSIONS_MAX)
  )
  expect(
    normalizeAiVaultViewOptions({ pinnedSessions: ['a', 7, 'a', null, 'b'] }).pinnedSessions
  ).toEqual(['a', 'b'])
  expect(normalizeAiVaultViewOptions({ pinnedSessions: 'a' }).pinnedSessions).toEqual([])
  expect(normalizeAiVaultViewOptions({}).pinnedSessions).toEqual([])
})
