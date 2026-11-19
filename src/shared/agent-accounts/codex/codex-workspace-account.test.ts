import { expect, it } from 'vitest'
import { assignCodexWorkspaceAccount } from './codex-workspace-account'
import { effectiveWorkspaceAccountId } from '../workspace-account-binding'

it('updates one workspace without replacing other assignments and clears only that workspace', () => {
  const accounts = [{ id: 'personal' }, { id: 'work' }]
  const first = assignCodexWorkspaceAccount(
    { codexManagedAccounts: accounts },
    { workspaceId: 'folder:a', accountId: 'work' }
  )
  const both = assignCodexWorkspaceAccount(
    { codexManagedAccounts: accounts, codexWorkspaceAccounts: first },
    { workspaceId: 'worktree:project::/work/b', accountId: 'personal' }
  )
  expect(both).toEqual({ 'folder:a': 'work', 'project::/work/b': 'personal' })
  expect(
    assignCodexWorkspaceAccount(
      { codexWorkspaceAccounts: both },
      { workspaceId: 'folder:a', accountId: null }
    )
  ).toEqual({ 'project::/work/b': 'personal' })
})

it('rejects an account that does not belong to the host', () => {
  expect(() =>
    assignCodexWorkspaceAccount(
      { codexManagedAccounts: [{ id: 'personal' }] },
      { workspaceId: 'folder:a', accountId: 'remote-account' }
    )
  ).toThrow('That Codex account no longer exists on this host.')
})

it('resolves inheritance, managed bindings and the real system default against the host selection', () => {
  expect(effectiveWorkspaceAccountId({}, 'folder:a', 'personal')).toBe('personal')
  expect(effectiveWorkspaceAccountId({}, 'folder:a', null)).toBeNull()
  expect(effectiveWorkspaceAccountId({ 'folder:a': 'work' }, 'folder:a', 'personal')).toBe('work')
  expect(
    effectiveWorkspaceAccountId({ 'folder:a': 'system-default' }, 'folder:a', 'personal')
  ).toBeNull()
})

it('saves a real system-default assignment separately from inheriting the host account', () => {
  expect(
    assignCodexWorkspaceAccount({}, { workspaceId: 'folder:a', accountId: 'system-default' })
  ).toEqual({
    'folder:a': 'system-default'
  })
  expect(
    assignCodexWorkspaceAccount(
      { codexWorkspaceAccounts: { 'folder:a': 'system-default' } },
      {
        workspaceId: 'folder:a',
        accountId: null
      }
    )
  ).toEqual({})
})
