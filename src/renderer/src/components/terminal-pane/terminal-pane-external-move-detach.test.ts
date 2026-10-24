import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resetAgentPaneAuthorityAliasesForTests,
  transferAgentPaneAuthorityAlias
} from '@/store/slices/agent-pane-authority'
import { detachExternallyMovedPane } from './terminal-pane-external-move-detach'

const SOURCE = 'web-terminal-source'
const TARGET = 'web-terminal-target'
const LEAF = '11111111-1111-4111-8111-111111111111'

function detach(): ReturnType<typeof vi.fn> {
  const retire = vi.fn()
  detachExternallyMovedPane({
    manager: { getLeafId: () => LEAF, detachPaneForExternalMove: () => true },
    paneId: 2,
    tabId: SOURCE,
    retireAgentPaneAuthority: retire
  })
  return retire
}

describe('detachExternallyMovedPane', () => {
  afterEach(() => resetAgentPaneAuthorityAliasesForTests())

  it('retires the source pane’s agent records after another client moved it', () => {
    expect(detach()).toHaveBeenCalledWith(makePaneKey(SOURCE, LEAF))
  })

  it('keeps the target’s records when this window already moved the pane there', () => {
    // Why: a pre-move snapshot can redraw the source pane after this window's own move; its
    // later removal must not retire the live target the source key now aliases.
    transferAgentPaneAuthorityAlias({
      fromPaneKey: makePaneKey(SOURCE, LEAF),
      toPaneKey: makePaneKey(TARGET, LEAF),
      ptyId: 'remote:env@@term-1'
    })
    expect(detach()).not.toHaveBeenCalled()
  })
})
