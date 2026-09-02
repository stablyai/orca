import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentSendPopoverTargetMode } from '@/store/slices/ui'
import {
  EMPTY_SEND_TARGET_CONTROL_INPUTS,
  EMPTY_SEND_TARGET_INPUTS,
  selectSendTargetControlInputs,
  selectSendTargetInputs,
  type SendTargetControlInputsState,
  type SendTargetInputsState
} from './worktree-card-send-target-inputs'

const BASE: SendTargetInputsState = {
  agentSendPopoverTargetMode: null,
  agentStatusByPaneKey: {},
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {}
}

function makeMode(worktreeId: string): AgentSendPopoverTargetMode {
  return {
    id: 'mode-1',
    instanceId: 'inst-1',
    worktreeId,
    source: 'diff-notes',
    prompt: 'do it',
    label: 'Send',
    launchSource: 'sidebar',
    eligiblePaneKeys: [],
    disabledPaneKeys: {},
    status: 'open'
  }
}

describe('selectSendTargetInputs', () => {
  it('returns the shared empty constant when the popover does not target this worktree', () => {
    // Inactive (popover closed): stable empty reference.
    const inactive = selectSendTargetInputs(BASE, 'wt-A')
    expect(inactive).toBe(EMPTY_SEND_TARGET_INPUTS)

    // Churning the hottest maps while inactive must NOT change the selected
    // reference, so a useShallow subscription skips the re-render.
    const churned: SendTargetInputsState = {
      ...BASE,
      runtimePaneTitlesByTabId: { 'tab-1': 'claude' },
      agentStatusByPaneKey: { 'tab-1:leaf-1': {} as never }
    }
    const afterChurn = selectSendTargetInputs(churned, 'wt-A')
    expect(afterChurn).toBe(EMPTY_SEND_TARGET_INPUTS)
    expect(shallow(inactive, afterChurn)).toBe(true)
  })

  it('stays the stable empty constant when the popover targets a different worktree', () => {
    const s: SendTargetInputsState = { ...BASE, agentSendPopoverTargetMode: makeMode('wt-OTHER') }
    expect(selectSendTargetInputs(s, 'wt-A')).toBe(EMPTY_SEND_TARGET_INPUTS)
  })

  it('exposes the live maps when the popover targets this worktree', () => {
    const titles = { 'tab-1': 'claude' }
    const s: SendTargetInputsState = {
      ...BASE,
      agentSendPopoverTargetMode: makeMode('wt-A'),
      runtimePaneTitlesByTabId: titles
    }
    const active = selectSendTargetInputs(s, 'wt-A')
    // Live map references pass straight through so eligibility derives correctly.
    expect(active.runtimePaneTitlesByTabId).toBe(titles)
    expect(active).not.toBe(EMPTY_SEND_TARGET_INPUTS)
  })

  it('shallow-changes only when a subscribed map reference actually changes while active', () => {
    const titles = { 'tab-1': 'claude' }
    const s1: SendTargetInputsState = {
      ...BASE,
      agentSendPopoverTargetMode: makeMode('wt-A'),
      runtimePaneTitlesByTabId: titles
    }
    const r1 = selectSendTargetInputs(s1, 'wt-A')

    // Same underlying map refs -> shallow-equal -> no re-render.
    expect(shallow(r1, selectSendTargetInputs(s1, 'wt-A'))).toBe(true)

    // A real pane-title write replaces the map ref -> shallow-unequal -> the
    // open popover re-derives eligibility, exactly as before this change.
    const s2: SendTargetInputsState = { ...s1, runtimePaneTitlesByTabId: { 'tab-1': 'codex' } }
    expect(shallow(r1, selectSendTargetInputs(s2, 'wt-A'))).toBe(false)
  })
})

describe('selectSendTargetControlInputs', () => {
  it('stays stable across global epoch changes while the picker is closed', () => {
    const first = selectSendTargetControlInputs(
      { agentSendPopoverTargetMode: null, agentStatusEpoch: 1 },
      'wt-A'
    )
    const afterEpoch = selectSendTargetControlInputs(
      { agentSendPopoverTargetMode: null, agentStatusEpoch: 2 },
      'wt-A'
    )

    expect(first).toBe(EMPTY_SEND_TARGET_CONTROL_INPUTS)
    expect(afterEpoch).toBe(EMPTY_SEND_TARGET_CONTROL_INPUTS)
    expect(shallow(first, afterEpoch)).toBe(true)
  })

  it('stays stable when the picker targets another worktree', () => {
    const state: SendTargetControlInputsState = {
      agentSendPopoverTargetMode: makeMode('wt-B'),
      agentStatusEpoch: 3
    }

    expect(selectSendTargetControlInputs(state, 'wt-A')).toBe(EMPTY_SEND_TARGET_CONTROL_INPUTS)
  })

  it('tracks the mode and freshness epoch only for the targeted worktree', () => {
    const mode = makeMode('wt-A')
    const first = selectSendTargetControlInputs(
      { agentSendPopoverTargetMode: mode, agentStatusEpoch: 4 },
      'wt-A'
    )
    const afterEpoch = selectSendTargetControlInputs(
      { agentSendPopoverTargetMode: mode, agentStatusEpoch: 5 },
      'wt-A'
    )

    expect(first).toEqual({ targetMode: mode, agentStatusEpoch: 4 })
    expect(shallow(first, afterEpoch)).toBe(false)
  })
})
