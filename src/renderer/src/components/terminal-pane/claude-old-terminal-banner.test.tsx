// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ClaudeOldTerminalBanner } from './ClaudeOldTerminalBanner'

const routing = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn(() => ({})) }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: routing.activateAndRevealWorkspace
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const TITLE = "This terminal was opened before Orca's Claude account update"
const ACCOUNT: ClaudeManagedAccount = {
  id: 'a',
  email: 'a@example.test',
  authMethod: 'subscription-oauth',
  managedAuthPath: '/unused',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}
let paneElement: HTMLDivElement
let root: Root
let openedBeforeClaudeAccounts: ReturnType<
  typeof vi.fn<(id: string, target: { runtime: string }) => Promise<boolean>>
>
let nextPtyId = 0
let ptyId: string

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const FLOATING_TAB = {
  id: 'unified-floating',
  entityId: TAB_ID,
  groupId: 'group-1',
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  contentType: 'terminal' as const,
  label: 'Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function setState(settings: Partial<GlobalSettings>, agent: 'claude' | 'codex' = 'claude'): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), ...settings },
    paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent, shellForeground: false } },
    // A floating terminal runs on the host.
    unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [FLOATING_TAB] }
  })
}

const SELECTED = { claudeManagedAccounts: [ACCOUNT], activeClaudeManagedAccountId: 'a' }

async function renderBanner(): Promise<void> {
  await act(async () => {
    root.render(<ClaudeOldTerminalBanner ptyId={ptyId} tabId={TAB_ID} leafId={LEAF_ID} />)
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState(useAppStore.getInitialState(), true)
  ptyId = `pty-${(nextPtyId += 1)}`
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  openedBeforeClaudeAccounts = vi.fn(() => Promise.resolve(true))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { openedBeforeClaudeAccounts } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('ClaudeOldTerminalBanner', () => {
  it('says Claude in an older terminal uses System default, with a new terminal and Learn more', async () => {
    setState(SELECTED)
    await renderBanner()
    expect(openedBeforeClaudeAccounts).toHaveBeenCalledWith(ptyId, { runtime: 'host' })
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).toContain("so claude here uses System default's login.")
    button('Open new terminal')
    expect(() => button("Don't show again")).toThrow()

    await act(async () => button('Learn more').click())
    expect(document.body.textContent).toContain('Open a new terminal to use the selected account.')
  })

  it('opens a new terminal beside the tab from the banner', async () => {
    const openNewTerminalTabInActiveWorkspace = vi.fn(() => Promise.resolve())
    setState(SELECTED)
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-1',
            entityId: TAB_ID,
            groupId: 'group-2',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the banner reads only a worktree's id and path.
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', path: '/repos/wt-1' } as Worktree] },
      openNewTerminalTabInActiveWorkspace
    })
    await renderBanner()
    await act(async () => button('Open new terminal').click())
    expect(openNewTerminalTabInActiveWorkspace).toHaveBeenCalledWith('group-2')
  })

  it('stays hidden for a terminal from this version, an SSH pane, or one after Dismiss', async () => {
    setState(SELECTED)
    openedBeforeClaudeAccounts.mockResolvedValue(false)
    await renderBanner()
    expect(paneElement.textContent).toBe('')

    openedBeforeClaudeAccounts.mockResolvedValue(true)
    ptyId = `pty-${(nextPtyId += 1)}`
    await renderBanner()
    await act(async () => button('Dismiss').click())
    expect(paneElement.textContent).toBe('')
  })

  it('never asks without Claude in the pane or a selected account', async () => {
    setState(SELECTED, 'codex')
    await renderBanner()
    setState({ claudeManagedAccounts: [ACCOUNT], activeClaudeManagedAccountId: null })
    await renderBanner()
    setState({ claudeManagedAccounts: [], activeClaudeManagedAccountId: 'a' })
    await renderBanner()
    // A pane whose tab is unknown has no runtime to judge it by.
    setState(SELECTED)
    useAppStore.setState({ unifiedTabsByWorktree: {} })
    await renderBanner()
    expect(openedBeforeClaudeAccounts).not.toHaveBeenCalled()
    expect(paneElement.textContent).toBe('')
  })
})
