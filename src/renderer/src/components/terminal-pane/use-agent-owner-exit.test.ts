// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPresenceByPaneKey } from '@/store/slices/agent-presence'
import { useAgentOwnerExit } from './use-agent-owner-exit'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:1' }
} as const
const live: AgentPresenceByPaneKey = { [PANE]: { presence: owner, receivedAt: 1 } }
const ended: AgentPresenceByPaneKey = {
  [PANE]: { presence: { ...owner, ended: true }, receivedAt: 2 }
}

const roots: Root[] = []
function Probe(props: { records: AgentPresenceByPaneKey; onExit: () => void }): null {
  useAgentOwnerExit(props.records, 'tab-1', LEAF, props.onExit)
  return null
}

async function renderSequence(sequence: AgentPresenceByPaneKey[], onExit: () => void) {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  roots.push(root)
  for (const records of sequence) {
    await act(async () => root.render(createElement(Probe, { records, onExit })))
  }
}

describe('useAgentOwnerExit', () => {
  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()))
    document.body.replaceChildren()
  })

  it('leaves Chat when the owner exits while its terminal lives', async () => {
    const onExit = vi.fn()
    await renderSequence([live, ended], onExit)
    expect(onExit).toHaveBeenCalledWith(LEAF, 'exited')
  })

  it('keeps the view when the host releases the owner with its terminal (sleep, hibernate)', async () => {
    const onExit = vi.fn()
    await renderSequence([live, {}], onExit)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('treats an owner already ended at mount as history, as after a wake', async () => {
    const onExit = vi.fn()
    await renderSequence([ended, ended], onExit)
    expect(onExit).not.toHaveBeenCalled()
  })
})
