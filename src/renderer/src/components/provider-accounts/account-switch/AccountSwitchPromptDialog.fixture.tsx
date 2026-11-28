import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  antigravityAccountSwitchCopy,
  claudeAccountSwitchCopy
} from '@/lib/provider-accounts/account-switch-copy'
import type { AccountSwitchPrompt } from '@/lib/provider-accounts/account-switch-prompt'
import AccountSwitchPromptDialog from './AccountSwitchPromptDialog'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

const rows = {
  worktreesByRepo: {
    'repo-1': [
      { id: 'wt-api', repoId: 'repo-1', path: '/src/api', branch: 'refs/heads/fix-auth' },
      { id: 'wt-web', repoId: 'repo-1', path: '/src/web', branch: 'refs/heads/main' }
    ]
  },
  tabsByWorktree: {
    'wt-api': [
      { id: 'tab-a', worktreeId: 'wt-api', title: 'agy' },
      { id: 'tab-b', worktreeId: 'wt-api', title: 'agy review' }
    ],
    'wt-web': [{ id: 'tab-c', worktreeId: 'wt-web', title: 'agy' }]
  }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog's rows read only these fields.
const store = rows as never

const session = (ptyId: string, worktreeId: string, tabId: string, leafId: string) => ({
  ptyId,
  worktreeId,
  tabId,
  leafId
})

const one: AccountSwitchPrompt = {
  id: 1,
  sessions: {
    onAccount: [session('pty-a', 'wt-api', 'tab-a', LEAF_A)],
    elsewhere: [],
    cantMove: []
  },
  previousAccountLabel: 'work@example.com',
  nextAccountLabel: 'personal@example.com'
}

export const antigravityOne = defineFixture({
  store,
  render: () => (
    <AccountSwitchPromptDialog
      prompt={one}
      copy={antigravityAccountSwitchCopy()}
      onAnswer={() => {}}
    />
  )
})

export const antigravityOneFresh = defineFixture({
  store,
  render: () => (
    <AccountSwitchPromptDialog
      prompt={{
        ...one,
        sessions: {
          ...one.sessions,
          onAccount: [
            { ...session('pty-a', 'wt-api', 'tab-a', LEAF_A), reason: 'new-conversation' }
          ]
        }
      }}
      copy={antigravityAccountSwitchCopy()}
      onAnswer={() => {}}
    />
  )
})

const several: AccountSwitchPrompt = {
  ...one,
  sessions: {
    onAccount: [
      session('pty-a', 'wt-api', 'tab-a', LEAF_A),
      { ...session('pty-b', 'wt-api', 'tab-b', LEAF_B), reason: 'new-conversation' }
    ],
    elsewhere: [
      { ...session('pty-c', 'wt-web', 'tab-c', LEAF_C), accountLabel: 'team@example.com' }
    ],
    cantMove: []
  }
}

export const antigravitySeveral = defineFixture({
  store,
  width: 640,
  render: () => (
    <AccountSwitchPromptDialog
      prompt={several}
      copy={antigravityAccountSwitchCopy()}
      onAnswer={() => {}}
    />
  )
})

export const antigravityReview = defineFixture({
  store,
  width: 640,
  render: () => (
    <AccountSwitchPromptDialog
      prompt={{ ...several, review: true, sessions: { ...several.sessions, onAccount: [] } }}
      copy={antigravityAccountSwitchCopy()}
      onAnswer={() => {}}
    />
  )
})

// Claude's dialog, now drawn by the same component.
export const claudeOne = defineFixture({
  store,
  render: () => (
    <AccountSwitchPromptDialog prompt={one} copy={claudeAccountSwitchCopy()} onAnswer={() => {}} />
  )
})
