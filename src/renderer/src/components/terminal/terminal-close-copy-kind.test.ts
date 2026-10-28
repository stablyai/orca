/** Keyboard pane-close and tab-strip prompts must resolve identical copy (#10142). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

import { resolveBusyPtyCloseCopyKind, resolveLeafCloseCopyKind } from './terminal-close-copy-kind'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    terminalLayoutsByTabId: {
      'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
    },
    agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'claude' } },
    ...overrides
  })
}

describe('terminal close copy kind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setState()
  })

  it('never throws on a tab id that makePaneKey would reject', () => {
    setState({
      terminalLayoutsByTabId: { 'tab:1': { ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } } }
    })

    expect(resolveLeafCloseCopyKind('tab:1', LEAF_B)).toBe('command')
    expect(resolveBusyPtyCloseCopyKind('tab:1', ['pty-b'])).toBe('command')
  })

  it('ignores an unknown agent type', () => {
    setState({ agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'unknown' } } })

    expect(resolveLeafCloseCopyKind('tab-1', LEAF_B)).toBe('command')
    expect(resolveBusyPtyCloseCopyKind('tab-1', ['pty-b'])).toBe('command')
  })
})
