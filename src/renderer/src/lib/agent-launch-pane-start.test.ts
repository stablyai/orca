import { describe, expect, it } from 'vitest'
import { awaitAgentLaunchPaneStart, settleAgentLaunchPaneStart } from './agent-launch-pane-start'
import { noteAgentLaunchPaneClosedByUser } from './agent-launch-pane-closes'

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe("an AI button's pane says whether its agent started", () => {
  it('once: the first answer stands, and only for that pane', async () => {
    const started = awaitAgentLaunchPaneStart(TAB, LEAF)
    settleAgentLaunchPaneStart(TAB, 'another-leaf', 'pty-other')
    settleAgentLaunchPaneStart(TAB, LEAF, 'pty-1')
    settleAgentLaunchPaneStart(TAB, LEAF, null)
    await expect(started).resolves.toBe('pty-1')
  })

  it('no, when the user closes it before its spawn returns', async () => {
    const started = awaitAgentLaunchPaneStart(TAB, LEAF)
    noteAgentLaunchPaneClosedByUser(TAB, LEAF)
    await expect(started).resolves.toBeNull()
  })
})
