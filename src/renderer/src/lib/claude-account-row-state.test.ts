import { beforeEach, expect, it } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'
import { i18n } from '../i18n/i18n'
import { getClaudeAccountRowState } from './claude-account-row-state'

const account = (
  email: string,
  extra: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary => ({
  id: email || 'draft',
  email,
  managedAuthRuntime: 'host',
  wslDistro: null,
  authMethod: 'subscription-oauth',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  profileReadiness: 'ready',
  ...extra
})

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

it('keeps the added-as email as the label when the profile holds another saved login', () => {
  const row = getClaudeAccountRowState(
    account('a@example.test', {
      profileEmail: 'b@example.test',
      profileIdentityIssue: 'duplicate'
    })
  )
  expect(row.label).toBe('a@example.test')
  expect(row.problem).toBe(
    'This account was added as a@example.test but is now signed in as b@example.test, which is already added as another account. Sign in again as a@example.test, or remove this account.'
  )
  expect(row.selectable).toBe(false)
})

it('shows a finished draft by the login its profile holds', () => {
  expect(getClaudeAccountRowState(account('', { profileEmail: 'c@example.test' })).label).toBe(
    'c@example.test'
  )
  expect(getClaudeAccountRowState(account('')).label).toBe('Unfinished sign-in')
})
