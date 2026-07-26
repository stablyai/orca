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

  it('exposes both live maps the instant a restart notice exists', () => {
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    const codexRestartNoticeByPtyId = { 'pty-1': {} as never }
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
      codexRestartNoticeByPtyId: { 'pty-1': {} as never }
    }
    const r1 = selectCodexRestartInputs(s1)
    expect(shallow(r1, selectCodexRestartInputs(s1))).toBe(true)

    const s2: CodexRestartInputsState = { ...s1, ptyIdsByTabId: { 'tab-1': ['pty-9'] } }
    expect(shallow(r1, selectCodexRestartInputs(s2))).toBe(false)
  })
})
