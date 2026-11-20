// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumePendingTerminalTabRename,
  RENAME_TERMINAL_TAB_EVENT,
  requestTerminalTabRenameWhenMounted,
  type RenameTerminalTabDetail
} from './terminal-tabs/terminal-tab-rename-request'

const listeners: [string, EventListener][] = []

afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) {
    window.removeEventListener(type, listener)
  }
  document.body.replaceChildren()
})

describe('requestTerminalTabRenameWhenMounted', () => {
  it('queues a rename until the launched tab mounts its title editor', async () => {
    const renamedTabIds: string[] = []
    const listener: EventListener = (event) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: requestTerminalTabRename always dispatches CustomEvent<RenameTerminalTabDetail>.
      renamedTabIds.push((event as CustomEvent<RenameTerminalTabDetail>).detail.tabId)
    }
    listeners.push([RENAME_TERMINAL_TAB_EVENT, listener])
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, listener)

    requestTerminalTabRenameWhenMounted('new-tab')
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(renamedTabIds).toEqual([])
    expect(consumePendingTerminalTabRename('new-tab')).toBe(true)
    expect(consumePendingTerminalTabRename('new-tab')).toBe(false)
  })

  it('requests a mounted chat header after paint', async () => {
    const renamedTabIds: string[] = []
    const listener: EventListener = (event) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: requestTerminalTabRename always dispatches CustomEvent<RenameTerminalTabDetail>.
      renamedTabIds.push((event as CustomEvent<RenameTerminalTabDetail>).detail.tabId)
    }
    listeners.push([RENAME_TERMINAL_TAB_EVENT, listener])
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, listener)
    const header = document.createElement('div')
    header.dataset.chatPanelHeader = ''
    header.dataset.chatPanelActiveTabId = 'chat-1'
    document.body.append(header)

    requestTerminalTabRenameWhenMounted('chat-1')
    await vi.waitFor(() => expect(renamedTabIds).toEqual(['chat-1']))
  })
})
