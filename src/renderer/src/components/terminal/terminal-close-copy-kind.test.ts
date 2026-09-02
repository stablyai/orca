/**
 * The keyboard (pane-scoped) and tab-strip (pty-scoped) close prompts must word the same
 * close the same way, so both resolve their copy through this module (#10142).
 */
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

  it('agrees between the pane lookup and the busy-pty lookup for the same pane', () => {
    expect(resolveLeafCloseCopyKind('tab-1', LEAF_B)).toBe('agent')
    expect(resolveBusyPtyCloseCopyKind('tab-1', ['pty-b'])).toBe('agent')

    expect(resolveLeafCloseCopyKind('tab-1', LEAF_A)).toBe('command')
    expect(resolveBusyPtyCloseCopyKind('tab-1', ['pty-a'])).toBe('command')
  })

  it('prefers the agent copy when a split has both busy', () => {
    expect(resolveBusyPtyCloseCopyKind('tab-1', ['pty-a', 'pty-b'])).toBe('agent')
  })

  it.each([
    ['a missing leaf id', undefined],
    ['a null leaf id', null],
    ['a legacy non-uuid leaf id', 'leaf']
  ])('falls back to the command copy for %s', (_label, leafId) => {
    expect(resolveLeafCloseCopyKind('tab-1', leafId)).toBe('command')
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
