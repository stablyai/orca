import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNotesSendTargetModeId, NotesSendMenu } from './NotesSendMenu'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import { resetNotesInFlightForTests } from '@/lib/notes-send-in-flight'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

type TestNote = DiffCommentDeliverySnapshot

function note(id: string): TestNote {
  return { id, body: `body of ${id}`, filePath: 'README.md', lineNumber: 1 }
}

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  cleanups: [] as (() => void)[]
}))

const storeMocks = vi.hoisted(() => ({
  openAgentSendPopoverTargetMode: vi.fn(),
  closeAgentSendPopoverTargetMode: vi.fn(),
  state: {
    agentSendPopoverTargetMode: null as { id: string } | null
  }
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback
    },
    useEffect(effect: () => void | (() => void)): void {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        hookRuntime.cleanups.push(cleanup)
      }
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
    useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T): T {
      return getSnapshot()
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = hookRuntime.index++
      if (!(stateIndex in hookRuntime.states)) {
        hookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        hookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(hookRuntime.states[stateIndex] as T)
            : next
      }
      return [hookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openAgentSendPopoverTargetMode: storeMocks.openAgentSendPopoverTargetMode,
      closeAgentSendPopoverTargetMode: storeMocks.closeAgentSendPopoverTargetMode,
      agentSendPopoverTargetMode: storeMocks.state.agentSendPopoverTargetMode,
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      runtimePaneTitlesByTabId: {}
    })
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: Record<string, unknown>) {
    return { type: 'DropdownMenu', props }
  },
  DropdownMenuContent: function DropdownMenuContent(props: Record<string, unknown>) {
    return { type: 'DropdownMenuContent', props }
  },
  DropdownMenuItem: function DropdownMenuItem(props: Record<string, unknown>) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: Record<string, unknown>) {
    return { type: 'DropdownMenuLabel', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSeparator', props }
  },
  DropdownMenuSub: function DropdownMenuSub(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSub', props }
  },
  DropdownMenuSubContent: function DropdownMenuSubContent(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSubContent', props }
  },
  DropdownMenuSubTrigger: function DropdownMenuSubTrigger(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSubTrigger', props }
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: Record<string, unknown>) {
    return { type: 'DropdownMenuTrigger', props }
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip(props: Record<string, unknown>) {
    return { type: 'Tooltip', props }
  },
  TooltipContent: function TooltipContent(props: Record<string, unknown>) {
    return { type: 'TooltipContent', props }
  },
  TooltipTrigger: function TooltipTrigger(props: Record<string, unknown>) {
    return { type: 'TooltipTrigger', props }
  }
}))

vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems(props: Record<string, unknown>) {
    return { type: 'QuickLaunchAgentMenuItems', props }
  }
}))

vi.mock('./ReviewNotesSendMenuContent', () => ({
  ReviewNotesSendMenuContent: function ReviewNotesSendMenuContent(props: Record<string, unknown>) {
    return { type: 'ReviewNotesSendMenuContent', props }
  }
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (status: string) => status,
  getActiveTerminalNoteTarget: () => null,
  sendNotesToActiveAgentSession: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

function resetHookRuntime(): void {
  hookRuntime.states = []
  hookRuntime.index = 0
  hookRuntime.cleanups = []
}

function expand(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map((entry) => expand(entry))
  }
  if (!React.isValidElement(node)) {
    if (typeof node === 'object' && 'props' in node) {
      const element = node as ReactElementLike
      return {
        ...element,
        props: {
          ...element.props,
          children: expand(element.props.children)
        }
      }
    }
    return node
  }
  const element = node as React.ReactElement<Record<string, unknown>>
  if (typeof element.type === 'function') {
    const Component = element.type as (props: Record<string, unknown>) => unknown
    return expand(Component(element.props))
  }
  return {
    type: element.type,
    props: {
      ...element.props,
      children: expand(element.props.children)
    }
  }
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findAllByType(node: unknown, type: unknown): ReactElementLike[] {
  const found: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === type) {
      found.push(entry)
    }
  })
  return found
}

function findByType(node: unknown, type: unknown): ReactElementLike {
  const found = findAllByType(node, type)[0]
  if (!found) {
    throw new Error(`element not found: ${String(type)}`)
  }
  return found
}

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof NotesSendMenu<TestNote>>> = {}
): unknown {
  hookRuntime.index = 0
  return expand(
    <NotesSendMenu<TestNote>
      worktreeId="wt-1"
      groupId="group-1"
      modeIdParts={['markdown-notes', 'wt-1', 'README.md', 'rail']}
      scopes={[
        {
          id: 'all',
          label: 'All unsent notes',
          notes: [note('note-1')],
          formatPrompt: () => 'prompt-all'
        }
      ]}
      onDelivered={vi.fn()}
      {...overrides}
    />
  )
}

describe('buildNotesSendTargetModeId', () => {
  it('keeps note-send target ids stable for the same parts', () => {
    expect(buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail'])).toBe(
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail'])
    )
  })

  it('uses part boundaries so adjacent values cannot collide', () => {
    expect(buildNotesSendTargetModeId(['markdown-notes', 'ab', 'c'])).not.toBe(
      buildNotesSendTargetModeId(['markdown-notes', 'a', 'bc'])
    )
  })

  it('separates markdown rail, panel, per-note, and diff send targets', () => {
    const ids = new Set([
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail']),
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'preview-panel']),
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'note', 'note-1']),
      buildNotesSendTargetModeId(['diff-notes', 'wt-1', 'group-1', 'README.md'])
    ])

    expect(ids.size).toBe(4)
  })
})

describe('NotesSendMenu', () => {
  beforeEach(() => {
    resetHookRuntime()
    storeMocks.openAgentSendPopoverTargetMode.mockReset()
    storeMocks.closeAgentSendPopoverTargetMode.mockReset()
    storeMocks.state.agentSendPopoverTargetMode = null
    resetNotesInFlightForTests()
  })

  it('disables the trigger when no scope has deliverable notes', () => {
    const tree = renderMenu({
      scopes: [{ id: 'all', label: 'All unsent notes', notes: [], formatPrompt: () => '' }]
    })

    expect(findByType(tree, 'button').props.disabled).toBe(true)
    expect(findByType(tree, 'button').props.title).toBe('All notes sent')
    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
  })

  it('uses caller-provided disabled tooltip copy for disabled note actions', () => {
    const tree = renderMenu({
      scopes: [{ id: 'note', label: 'This note', notes: [], formatPrompt: () => '' }],
      disabledTooltip: 'Note already sent'
    })

    expect(findByType(tree, 'button').props.title).toBe('Note already sent')
  })

  it('opens and closes target mode with the default scope', () => {
    const onDelivered = vi.fn()
    const tree = renderMenu({ onDelivered })
    expect(findByType(tree, 'button').props.title).toBe('Send notes to an agent')
    const dropdown = findByType(tree, 'DropdownMenu')

    ;(dropdown.props.onOpenChange as (open: boolean) => void)(true)

    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail']),
        worktreeId: 'wt-1',
        source: 'diff-notes',
        prompt: 'prompt-all',
        label: 'All unsent notes',
        launchSource: 'notes_send'
      })
    )

    const delivered = storeMocks.openAgentSendPopoverTargetMode.mock.calls[0][0]
      .onPromptDelivered as () => void
    delivered()
    expect(onDelivered).toHaveBeenCalledWith([note('note-1')])

    ;(dropdown.props.onOpenChange as (open: boolean) => void)(false)
    expect(storeMocks.closeAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail'])
    )
  })

  it('passes the default scope to review note send content', () => {
    const tree = renderMenu()

    expect(findByType(tree, 'ReviewNotesSendMenuContent').props).toMatchObject({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'prompt-all',
      promptDelivery: 'submit-after-ready',
      launchSource: 'notes_send'
    })
  })

  it('switches running-agent target mode when a different scope is focused', () => {
    const tree = renderMenu({
      defaultScopeId: 'file',
      scopes: [
        {
          id: 'file',
          label: 'This file',
          notes: [note('file-note')],
          formatPrompt: () => 'prompt-file'
        },
        {
          id: 'all',
          label: 'All unsent notes',
          notes: [note('all-note')],
          formatPrompt: () => 'prompt-all'
        }
      ]
    })
    const [fileTrigger, allTrigger] = findAllByType(tree, 'DropdownMenuSubTrigger')

    ;(fileTrigger.props.onFocus as () => void)()
    ;(allTrigger.props.onPointerEnter as () => void)()

    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prompt: 'prompt-file', label: 'This file' })
    )
    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: 'prompt-all', label: 'All unsent notes' })
    )
  })

  it('opens and reports handled when an open request arrives with deliverable notes', () => {
    const onOpenRequestHandled = vi.fn()
    renderMenu({ openRequestNonce: 1, onOpenRequestHandled })

    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'prompt-all', label: 'All unsent notes' })
    )
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('reports the open request handled without opening when nothing is deliverable', () => {
    const onOpenRequestHandled = vi.fn()
    renderMenu({
      openRequestNonce: 1,
      onOpenRequestHandled,
      scopes: [{ id: 'all', label: 'All unsent notes', notes: [], formatPrompt: () => '' }]
    })

    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('drops an expired open request without opening the menu', () => {
    const onOpenRequestHandled = vi.fn()
    vi.useFakeTimers()
    vi.setSystemTime(600_000)
    try {
      // Issued 10 minutes ago and never consumed: clear it, do not pop the menu.
      renderMenu({ openRequestNonce: 1, openRequestExpiresAt: 5_000, onOpenRequestHandled })
    } finally {
      vi.useRealTimers()
    }

    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('opens for an open request still inside its deadline', () => {
    const onOpenRequestHandled = vi.fn()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      renderMenu({ openRequestNonce: 1, openRequestExpiresAt: 6_000, onOpenRequestHandled })
    } finally {
      vi.useRealTimers()
    }

    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'prompt-all', label: 'All unsent notes' })
    )
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1)
  })

  it('ignores a null open request', () => {
    const onOpenRequestHandled = vi.fn()
    renderMenu({ openRequestNonce: null, onOpenRequestHandled })

    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
    expect(onOpenRequestHandled).not.toHaveBeenCalled()
  })

  it('closes when another target mode becomes active and cleans up on unmount', () => {
    hookRuntime.states[0] = true
    storeMocks.state.agentSendPopoverTargetMode = { id: 'some-other-menu' }

    const tree = renderMenu()

    expect(hookRuntime.states[0]).toBe(false)
    expect(findByType(tree, 'DropdownMenu').props.open).toBe(false)
    for (const cleanup of hookRuntime.cleanups) {
      cleanup()
    }
    expect(storeMocks.closeAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail'])
    )
  })
})

describe('NotesSendMenu notes in flight', () => {
  const noteA = note('note-a')
  const noteB = note('note-b')
  const scopeOf = (notes: TestNote[]) => [
    {
      id: 'all',
      label: 'All unsent notes',
      notes,
      formatPrompt: (sent: readonly TestNote[]) => sent.map((entry) => entry.id).join('+')
    }
  ]
  /** Calls a rendered callback prop, failing the test if it is missing. */
  const invoke = (props: Record<string, unknown>, name: string, ...args: unknown[]): unknown => {
    const callback = props[name]
    if (typeof callback !== 'function') {
      throw new Error(`${name} is not a function`)
    }
    return callback(...args)
  }
  const contentProps = (tree: unknown) => {
    const props = findByType(tree, 'ReviewNotesSendMenuContent').props
    return {
      prompt: props.prompt,
      onPromptDelivered: () => invoke(props, 'onPromptDelivered'),
      onPromptHandedOff: (delivered: Promise<unknown>) =>
        invoke(props, 'onPromptHandedOff', delivered)
    }
  }

  beforeEach(() => {
    resetHookRuntime()
    storeMocks.openAgentSendPopoverTargetMode.mockReset()
    storeMocks.state.agentSendPopoverTargetMode = null
    resetNotesInFlightForTests()
  })

  it('sends only a note added while an earlier send to a new agent is still on its way', async () => {
    const onDelivered = vi.fn()
    let deliverA!: (result: { delivered: boolean }) => void
    const first = contentProps(renderMenu({ scopes: scopeOf([noteA]), onDelivered }))
    first.onPromptHandedOff(new Promise((resolve) => (deliverA = resolve)))

    const second = contentProps(renderMenu({ scopes: scopeOf([noteA, noteB]), onDelivered }))
    expect(second.prompt).toBe('note-b')
    second.onPromptHandedOff(new Promise(() => undefined))

    first.onPromptDelivered()
    deliverA({ delivered: true })
    second.onPromptDelivered()
    await Promise.resolve()

    // Each send clears only its own note; a repeated clear of A is a no-op for its owner.
    expect(onDelivered).not.toHaveBeenCalledWith([noteA, noteB])
    expect(onDelivered).toHaveBeenCalledWith([noteA])
    expect(onDelivered).toHaveBeenCalledWith([noteB])
  })

  it('leaves the notes out of the running-agent target mode too', () => {
    contentProps(renderMenu({ scopes: scopeOf([noteA]) })).onPromptHandedOff(
      new Promise(() => undefined)
    )

    const tree = renderMenu({ scopes: scopeOf([noteA, noteB]) })
    invoke(findByType(tree, 'DropdownMenu').props, 'onOpenChange', true)

    expect(storeMocks.openAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'note-b', onPromptHandedOff: expect.any(Function) })
    )
  })

  it.each([
    ['an undelivered result', () => Promise.resolve({ delivered: false, failureNotified: true })],
    ['a failed start', () => Promise.reject(new Error('refused'))]
  ])('puts the notes back for the next send after %s', async (_name, deliver) => {
    const delivered = deliver()
    contentProps(renderMenu({ scopes: scopeOf([noteA]) })).onPromptHandedOff(delivered)
    expect(contentProps(renderMenu({ scopes: scopeOf([noteA]) })).prompt).toBe('')

    await delivered.catch(() => undefined)
    await Promise.resolve()

    expect(contentProps(renderMenu({ scopes: scopeOf([noteA]) })).prompt).toBe('note-a')
  })

  it('offers no send once every note is on its way', () => {
    contentProps(renderMenu({ scopes: scopeOf([noteA]) })).onPromptHandedOff(
      new Promise(() => undefined)
    )

    const tree = renderMenu({ scopes: scopeOf([noteA]) })
    expect(findByType(tree, 'button').props.disabled).toBe(true)
    invoke(findByType(tree, 'DropdownMenu').props, 'onOpenChange', true)
    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
  })

  it('says the notes are on their way, not sent, while every note is held', () => {
    contentProps(
      renderMenu({ scopes: scopeOf([noteA]), disabledTooltip: 'Note already sent' })
    ).onPromptHandedOff(new Promise(() => undefined))

    const tree = renderMenu({ scopes: scopeOf([noteA]), disabledTooltip: 'Note already sent' })

    expect(findByType(tree, 'button').props.title).toBe('Sending…')
  })

  // A failed new chat's Retry delivers them after the send's own callback is gone.
  it('clears notes whose send reports delivery later', async () => {
    const onDelivered = vi.fn()
    const delivered = Promise.resolve({ delivered: true })
    contentProps(renderMenu({ scopes: scopeOf([noteA]), onDelivered })).onPromptHandedOff(delivered)

    await delivered
    await Promise.resolve()

    expect(onDelivered).toHaveBeenCalledWith([noteA])
  })
})
