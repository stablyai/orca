// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const record = vi.hoisted(() => vi.fn())

vi.mock('@/lib/agent-session/history/session-names/terminal-session-name-recording', () => ({
  recordTerminalTabRename: record
}))

import { useAppStore } from '../index'
import { withTerminalSessionNameRecording } from './create-terminal-slice'
import type { AppState } from '../types'

function tab(customTitle: string | null) {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'claude',
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('tab rename records the session name', () => {
  beforeEach(() => {
    record.mockReset()
  })

  it('records before the wrapped rename runs, with the state from before it', () => {
    const calls: string[] = []
    const before: AppState = { ...useAppStore.getState(), tabsByWorktree: { 'wt-1': [tab('Old')] } }
    record.mockImplementation(() => calls.push('record'))
    const actions = withTerminalSessionNameRecording(
      { setTabCustomTitle: () => calls.push('rename') },
      () => before
    )
    actions.setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(calls).toEqual(['record', 'rename'])
    expect(record).toHaveBeenCalledWith(before, 'tab-1', 'Fix auth bug', { interactive: true })
  })

  it('passes whether a person renamed the tab', () => {
    const actions = withTerminalSessionNameRecording({ setTabCustomTitle: () => {} }, () =>
      useAppStore.getState()
    )
    actions.setTabCustomTitle('tab-1', 'Worker 3', { recordInteraction: false })
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Worker 3', {
      interactive: false
    })
  })

  it('still renames when recording fails', () => {
    record.mockImplementation(() => {
      throw new Error('boom')
    })
    const rename = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withTerminalSessionNameRecording({ setTabCustomTitle: rename }, () =>
      useAppStore.getState()
    ).setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(rename).toHaveBeenCalledWith('tab-1', 'Fix auth bug', undefined)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is the rename every store caller reaches', () => {
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab(null)] } })
    useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug', {
      interactive: true
    })
    expect(useAppStore.getState().tabsByWorktree['wt-1'][0].customTitle).toBe('Fix auth bug')
  })
})
