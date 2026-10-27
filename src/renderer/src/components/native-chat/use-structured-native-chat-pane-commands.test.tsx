/**
 * @vitest-environment happy-dom
 */
import React, { createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18n from '@/i18n/i18n'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'

type ItemProps = { onSelect?: () => void; children?: ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const callRuntimeRpc = vi.hoisted(() => vi.fn())
const paneActions = vi.hoisted(() => ({
  onSplitRight: vi.fn(() => true),
  onSplitDown: vi.fn(() => true),
  canClosePane: true,
  closeLabel: 'Close Pane',
  onClosePane: vi.fn()
}))
const store = vi.hoisted(() => ({
  keybindings: {},
  groupsByWorktree: { 'worktree-1': [{ id: 'group-1' }] }
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return props.children
    },
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuTrigger: Pass
  }
})
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null }
})
vi.mock('./use-structured-chat-pane-actions', () => ({
  useStructuredChatPaneActions: () => paneActions
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: typeof store) => unknown) => select(store)
}))
vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc
}))

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const TARGET = { kind: 'environment', environmentId: 'env_1' } as const

function childrenText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) =>
      typeof child === 'string'
        ? child
        : React.isValidElement<{ children?: ReactNode }>(child)
          ? childrenText(child.props.children)
          : ''
    )
    .join('')
}

function StructuredChatTab({ owner = 'worktree-1' }: { owner?: string | null }): ReactNode {
  const { menu } = useStructuredNativeChatPaneCommands({
    tabId: 'chat-tab',
    ownerWorktreeId: owner,
    groupId: 'group-1',
    isVisible: true,
    rootRef: createRef<HTMLDivElement>(),
    composerRef: createRef<NativeChatComposerHandle>(),
    questionAnswerInputRef: createRef<HTMLInputElement>(),
    sessionId: SESSION,
    target: TARGET
  })
  return menu
}

describe('a structured chat tab', () => {
  beforeEach(() => {
    items.list = []
    vi.clearAllMocks()
    store.groupsByWorktree['worktree-1'] = [{ id: 'group-1' }]
    callRuntimeRpc.mockReset().mockResolvedValue({ orcaSessionId: `orca_session_id:${SESSION}` })
    Object.assign(window, {
      api: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  it.each([false, true])('uses the header commands with split panes: %s', (split) => {
    if (split) {
      store.groupsByWorktree['worktree-1'].push({ id: 'group-2' })
    }
    const markup = renderToStaticMarkup(<StructuredChatTab />)
    expect(markup).not.toContain('Move Tab to Split')
    expect(markup).not.toContain('Resume in New CLI')
    expect(markup).not.toContain('Continue with Terminal Agent')
    for (const [label, command] of [
      ['Split Chat Right', paneActions.onSplitRight],
      ['Split Chat Down', paneActions.onSplitDown]
    ] as const) {
      const item = items.list.find((entry) => childrenText(entry.children).startsWith(label))
      expect(item).toBeDefined()
      item?.onSelect?.()
      expect(command).toHaveBeenCalledOnce()
    }
    const close = items.list.find((entry) => childrenText(entry.children) === 'Close Pane')
    expect(Boolean(close)).toBe(split)
    close?.onSelect?.()
    expect(paneActions.onClosePane).toHaveBeenCalledTimes(split ? 1 : 0)
  })

  it.each([null, ''])('keeps the session-ID fallback without a known owner: %s', (owner) => {
    const markup = renderToStaticMarkup(<StructuredChatTab owner={owner} />)
    expect(markup).not.toContain('Split Chat')
    expect(markup).toContain('Copy Orca Session ID')
  })

  it("offers Copy Orca Session ID, asking the tab's host for this session's Orca session ID", async () => {
    renderToStaticMarkup(<StructuredChatTab />)

    const item = items.list.find(
      (candidate) => childrenText(candidate.children) === 'Copy Orca Session ID'
    )
    item?.onSelect?.()

    expect(item).toBeDefined()
    await vi.waitFor(() =>
      expect(callRuntimeRpc).toHaveBeenCalledWith(TARGET, 'orchestration.sessionAddress', {
        sessionId: SESSION
      })
    )
  })
})
