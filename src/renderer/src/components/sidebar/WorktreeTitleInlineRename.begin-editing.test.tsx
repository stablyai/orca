import { beforeEach, describe, expect, it, vi } from 'vitest'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T>(callback: T) {
      return callback
    },
    useEffect(effect: () => void | (() => void)) {
      effect()
    },
    useRef<T>(initial: T) {
      return { current: initial }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = reactHookRuntime.index++
      if (!(stateIndex in reactHookRuntime.states)) {
        reactHookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        reactHookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(reactHookRuntime.states[stateIndex] as T)
            : next
      }
      return [reactHookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('lucide-react', () => ({
  LoaderCircle: function LoaderCircle(props: Record<string, unknown>) {
    return { type: 'LoaderCircle', props }
  }
}))

vi.mock('@/components/ui/input', () => ({
  Input: function Input(props: Record<string, unknown>) {
    return { type: 'input', props }
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip(props: { children?: unknown }) {
    return { type: 'Tooltip', props }
  },
  TooltipContent: function TooltipContent(props: { children?: unknown }) {
    return { type: 'TooltipContent', props }
  },
  TooltipTrigger: function TooltipTrigger(props: { children?: unknown }) {
    return props.children
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

async function renderTitleRename(props: {
  beginEditing: boolean
  disabled?: boolean
  onBeginEditingConsumed: () => void
}): Promise<unknown> {
  reactHookRuntime.index = 0
  const module = await import('./WorktreeTitleInlineRename')
  return module.WorktreeTitleInlineRename({
    displayName: 'Feature workspace',
    onRename: vi.fn(),
    ...props
  })
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findElementsByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null || typeof current === 'string' || typeof current === 'number') {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    const el = current as ReactElementLike
    if (el.type === typeName) {
      results.push(el)
    }
    visit(el.props?.children)
  }
  visit(node)
  return results
}

describe('WorktreeTitleInlineRename beginEditing', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
  })

  it('opens the inline input and consumes the parent trigger once', async () => {
    const onBeginEditingConsumed = vi.fn()

    await renderTitleRename({ beginEditing: true, onBeginEditingConsumed })
    const rerender = expandNode(
      await renderTitleRename({ beginEditing: false, onBeginEditingConsumed })
    )
    const inputs = findElementsByType(rerender, 'input')

    expect(onBeginEditingConsumed).toHaveBeenCalledTimes(1)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].props.value).toBe('Feature workspace')
    expect(inputs[0].props['data-worktree-title-rename-input']).toBe('true')
  })

  it('still consumes the trigger when the title is disabled', async () => {
    const onBeginEditingConsumed = vi.fn()

    await renderTitleRename({ beginEditing: true, disabled: true, onBeginEditingConsumed })
    const rerender = expandNode(
      await renderTitleRename({ beginEditing: false, disabled: true, onBeginEditingConsumed })
    )

    expect(onBeginEditingConsumed).toHaveBeenCalledTimes(1)
    expect(findElementsByType(rerender, 'input')).toHaveLength(0)
  })
})
