import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import {
  EMPTY_CODEX_RESTART_INPUTS,
  selectCodexRestartInputs,
  type CodexRestartInputsState
} from './codex-restart-chip-inputs'

describe('selectCodexRestartInputs', () => {
  it('returns the frozen empty bundle while no restart notice exists', () => {
    const state: CodexRestartInputsState = {
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      codexRestartNoticeByPtyId: {}
    }
    expect(selectCodexRestartInputs(state)).toBe(EMPTY_CODEX_RESTART_INPUTS)

    // Churning EITHER map while no notice exists must NOT change the selected
    // reference, so a useShallow subscription skips the re-render. This covers
    // the pty-teardown path that re-spreads codexRestartNoticeByPtyId even empty.
    const churnedPty: CodexRestartInputsState = {
      ...state,
      ptyIdsByTabId: { 'tab-1': ['pty-2'], 'tab-2': ['pty-3'] }
    }
    const churnedNotice: CodexRestartInputsState = {
      ptyIdsByTabId: state.ptyIdsByTabId,
      codexRestartNoticeByPtyId: {} // fresh empty object, same as a teardown re-spread
    }
    expect(selectCodexRestartInputs(churnedPty)).toBe(EMPTY_CODEX_RESTART_INPUTS)
    expect(selectCodexRestartInputs(churnedNotice)).toBe(EMPTY_CODEX_RESTART_INPUTS)
    expect(shallow(selectCodexRestartInputs(state), selectCodexRestartInputs(churnedNotice))).toBe(
      true
    )
  })

  it('re-idles once every surviving notice is answered', () => {
    // Why: answered notices linger as launch-account memory for the pty's whole
    // life, so existence alone would keep every chip subscribed to pty churn.
    const dismissed: CodexRestartInputsState = {
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      codexRestartNoticeByPtyId: {
        'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b', dismissed: true }
      }
    }
    expect(selectCodexRestartInputs(dismissed)).toBe(EMPTY_CODEX_RESTART_INPUTS)

    const alsoUnanswered: CodexRestartInputsState = {
      ...dismissed,
      codexRestartNoticeByPtyId: {
        ...dismissed.codexRestartNoticeByPtyId,
        'pty-2': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
      }
    }
    expect(selectCodexRestartInputs(alsoUnanswered)).not.toBe(EMPTY_CODEX_RESTART_INPUTS)
  })

  it('exposes both live maps the instant a restart notice exists', () => {
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    const codexRestartNoticeByPtyId = {
      'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
    }
    const state: CodexRestartInputsState = { ptyIdsByTabId, codexRestartNoticeByPtyId }
    const selected = selectCodexRestartInputs(state)
    // Live references pass straight through so the stale-pty memo + notice lookup derive fully.
    expect(selected.ptyIdsByTabId).toBe(ptyIdsByTabId)
    expect(selected.codexRestartNoticeByPtyId).toBe(codexRestartNoticeByPtyId)
    expect(selected).not.toBe(EMPTY_CODEX_RESTART_INPUTS)
  })

  it('shallow-changes only when a live map reference changes while a notice exists', () => {
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    const s1: CodexRestartInputsState = {
      ptyIdsByTabId,
      codexRestartNoticeByPtyId: {
        'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
      }
    }
    const r1 = selectCodexRestartInputs(s1)
    expect(shallow(r1, selectCodexRestartInputs(s1))).toBe(true)

    const s2: CodexRestartInputsState = { ...s1, ptyIdsByTabId: { 'tab-1': ['pty-9'] } }
    expect(shallow(r1, selectCodexRestartInputs(s2))).toBe(false)
  })
})
