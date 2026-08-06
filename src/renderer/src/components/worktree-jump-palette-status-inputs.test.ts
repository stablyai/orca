import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import {
  EMPTY_PALETTE_STATUS_INPUTS,
  selectPaletteStatusInputs,
  type PaletteStatusInputsState
} from './worktree-jump-palette-status-inputs'

const BASE: PaletteStatusInputsState = {
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {}
}

describe('selectPaletteStatusInputs', () => {
  it('returns the shared frozen constant while inactive', () => {
    const inactive = selectPaletteStatusInputs(BASE, false)
    expect(inactive).toBe(EMPTY_PALETTE_STATUS_INPUTS)

    // Churning the hottest maps while inactive must NOT change the selected
    // reference, so a useShallow subscription skips the re-render.
    const churned: PaletteStatusInputsState = {
      ...BASE,
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'claude' } },
      agentStatusByPaneKey: { 'tab-1:leaf-1': {} as never }
    }
    const afterChurn = selectPaletteStatusInputs(churned, false)
    expect(afterChurn).toBe(EMPTY_PALETTE_STATUS_INPUTS)
    expect(shallow(inactive, afterChurn)).toBe(true)
  })

  it('exposes the live maps the instant it becomes active', () => {
    const titles = { 'tab-1': { 0: 'claude' } }
    const state: PaletteStatusInputsState = { ...BASE, runtimePaneTitlesByTabId: titles }
    const active = selectPaletteStatusInputs(state, true)
    // Live map references pass straight through so status/sort derive correctly.
    expect(active.runtimePaneTitlesByTabId).toBe(titles)
    expect(active).not.toBe(EMPTY_PALETTE_STATUS_INPUTS)
  })

  it('keeps the live maps during the close linger (active stays true while animating)', () => {
    // The component holds `active` true through the close animation, so churn is
    // still reflected — no empty-row flash while the dialog fades out.
    const titles = { 'tab-1': { 0: 'claude' } }
    const closing = selectPaletteStatusInputs({ ...BASE, runtimePaneTitlesByTabId: titles }, true)
    expect(closing.runtimePaneTitlesByTabId).toBe(titles)
  })

  it('shallow-changes only when a subscribed map reference actually changes while active', () => {
    const titles = { 'tab-1': { 0: 'claude' } }
    const s1: PaletteStatusInputsState = { ...BASE, runtimePaneTitlesByTabId: titles }
    const r1 = selectPaletteStatusInputs(s1, true)

    // Same underlying map refs -> shallow-equal -> no re-render.
    expect(shallow(r1, selectPaletteStatusInputs(s1, true))).toBe(true)

    // A real pane-title write replaces the map ref -> shallow-unequal -> the
    // open palette re-derives status/order, exactly as before this change.
    const s2: PaletteStatusInputsState = {
      ...s1,
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'codex' } }
    }
    expect(shallow(r1, selectPaletteStatusInputs(s2, true))).toBe(false)
  })
})
