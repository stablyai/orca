import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNotesSendTargetModeId, NotesSendMenu } from './NotesSendMenu'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

type TestNote = {
  id: string
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
      agentSendPopoverTargetMode: storeMocks.state.agentSendPopoverTargetMode
    })
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

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (status: string) => status,
  sendNotesToActiveAgentSession: vi.fn(),
  useCanSendNotesToActiveTerminal: () => false
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
          notes: [{ id: 'note-1' }],
          prompt: 'prompt-all'
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
  })

  it('disables the trigger when no scope has deliverable notes', () => {
    const tree = renderMenu({
      scopes: [{ id: 'all', label: 'All unsent notes', notes: [], prompt: '' }]
    })

    expect(findByType(tree, 'button').props.disabled).toBe(true)
    expect(findByType(tree, 'button').props.title).toBe('All notes sent')
    expect(storeMocks.openAgentSendPopoverTargetMode).not.toHaveBeenCalled()
  })

  it('uses caller-provided disabled tooltip copy for disabled note actions', () => {
    const tree = renderMenu({
      scopes: [{ id: 'note', label: 'This note', notes: [], prompt: '' }],
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
    expect(onDelivered).toHaveBeenCalledWith([{ id: 'note-1' }])

    ;(dropdown.props.onOpenChange as (open: boolean) => void)(false)
    expect(storeMocks.closeAgentSendPopoverTargetMode).toHaveBeenCalledWith(
      buildNotesSendTargetModeId(['markdown-notes', 'wt-1', 'README.md', 'rail'])
    )
  })

  it('offers the active session action alongside new agent launchers', () => {
    const tree = renderMenu()

    expect(findByType(tree, 'DropdownMenuItem').props.disabled).toBe(true)
    expect(findByType(tree, 'QuickLaunchAgentMenuItems').props).toMatchObject({
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
        { id: 'file', label: 'This file', notes: [{ id: 'file-note' }], prompt: 'prompt-file' },
        { id: 'all', label: 'All unsent notes', notes: [{ id: 'all-note' }], prompt: 'prompt-all' }
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
