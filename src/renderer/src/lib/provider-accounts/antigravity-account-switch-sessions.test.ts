import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  answerAntigravityAccountSwitchPrompt,
  getAntigravityAccountSwitchPrompt,
  handleRunningAntigravityTerminalsAfterSwitch
} from './antigravity-account-switch-sessions'

const LEAF = '11111111-1111-4111-8111-111111111111'
const SWITCH = {
  previousAccountId: 'prev',
  accountId: 'next',
  terminals: [{ ptyId: 'pty-1', accountId: 'prev' }],
  accountEmails: {}
}

function withPolicy(policy: GlobalSettings['antigravityAccountSwitchRunningSessions']): void {
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads only this setting.
    settings: { antigravityAccountSwitchRunningSessions: policy } as GlobalSettings
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane lookup reads only tab ids.
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane lookup reads only ptyIdsByLeafId.
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } } as never,
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  })
})

it('restarts at once for a switch made elsewhere, since nobody here can answer Ask', () => {
  withPolicy('ask')
  expect(handleRunningAntigravityTerminalsAfterSwitch(SWITCH, true)).toBe('handled')
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'antigravity' })
  expect(getAntigravityAccountSwitchPrompt()).toBeNull()
})

it('asks before restarting a switch made in this window, and restarts what the answer picks', () => {
  withPolicy('ask')
  expect(handleRunningAntigravityTerminalsAfterSwitch(SWITCH)).toBe('handled')
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  expect(getAntigravityAccountSwitchPrompt()?.sessions.onAccount).toEqual([
    { ptyId: 'pty-1', worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF, reason: 'new-conversation' }
  ])

  answerAntigravityAccountSwitchPrompt('restart', { ptyIds: ['pty-1'] })
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'antigravity' })
})

it('drops a queued restart once a switch back leaves its terminal on the selected account', () => {
  withPolicy('restart')
  handleRunningAntigravityTerminalsAfterSwitch(SWITCH)
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'antigravity' })

  handleRunningAntigravityTerminalsAfterSwitch({
    ...SWITCH,
    previousAccountId: 'next',
    accountId: 'prev',
    terminals: []
  })
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
})

it.each([undefined, true as const])(
  'never restarts under Keep (made elsewhere: %s)',
  (elsewhere) => {
    withPolicy('keep')
    expect(handleRunningAntigravityTerminalsAfterSwitch(SWITCH, elsewhere)).toBe(
      'show-confirmation'
    )
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    expect(getAntigravityAccountSwitchPrompt()).toBeNull()
  }
)
