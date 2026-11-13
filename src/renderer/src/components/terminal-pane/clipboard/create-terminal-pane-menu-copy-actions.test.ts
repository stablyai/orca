// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'

const rpc = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/store/slices/worktrees/listing/worktree-owner-target', () => ({
  tryRuntimeTargetForWorktreeOwner: () => ({ kind: 'environment', environmentId: 'ssh-host' })
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))

import { createTerminalPaneMenuCopyActions } from './create-terminal-pane-menu-copy-actions'

const LEAF = '0517a0f3-3b48-40c8-b8f4-2c2664bf206d'

it("asks a remote pane's host by the host's own pane key", async () => {
  rpc.call.mockResolvedValue({ orcaSessionId: 'orca_session_id:claude_0123456789abcdef' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolve reads only the pane's leaf id.
  const pane = { leafId: LEAF } as ManagedPane
  const { agentIdCopy } = createTerminalPaneMenuCopyActions({
    paneTransportsRef: { current: new Map() },
    tabId: toWebTerminalSurfaceTabId('host-tab'),
    worktreeId: 'wt-1',
    resolveMenuPane: () => pane
  })
  expect(await agentIdCopy.resolve()).toBe('orca_session_id:claude_0123456789abcdef')
  expect(rpc.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'ssh-host' },
    'terminal.agentId',
    { paneKey: `host-tab:${LEAF}`, worktreeId: 'wt-1' }
  )
})

it('returns focus to the pane only if nothing else took it during the wait', async () => {
  let answer!: (value: unknown) => void
  rpc.call.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const container = document.createElement('div')
  const editor = document.createElement('input')
  document.body.append(container, editor)
  const focus = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy reads only the pane's leaf, container and focus.
  const pane = { leafId: LEAF, container, terminal: { focus } } as unknown as ManagedPane
  const { agentIdCopy } = createTerminalPaneMenuCopyActions({
    paneTransportsRef: { current: new Map() },
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    resolveMenuPane: () => pane
  })
  const copied = agentIdCopy.resolve()
  // The user moves to an editor while the host answers.
  editor.focus()
  answer({ orcaSessionId: null })
  await copied
  agentIdCopy.focusPane()
  expect(focus).not.toHaveBeenCalled()
  editor.blur()
  agentIdCopy.focusPane()
  expect(focus).toHaveBeenCalledOnce()
})
