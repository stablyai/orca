import { describe, expect, it, vi } from 'vitest'

const recordFeatureInteractionMock = vi.fn()

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    memo: function memo<T>(component: T): T {
      return component
    },
    useRef: function useRef<T>(current: T): { current: T } {
      return { current }
    }
  }
})

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: { recordFeatureInteraction: typeof recordFeatureInteractionMock }) => unknown
  ) => selector({ recordFeatureInteraction: recordFeatureInteractionMock })
}))

vi.mock('./tooltip', () => ({
  ProviderIcon: function ProviderIcon(props: Record<string, unknown>) {
    return { type: 'ProviderIcon', props }
  },
  ProviderPanel: function ProviderPanel(props: Record<string, unknown>) {
    return { type: 'ProviderPanel', props }
  },
  barColor: () => 'bg-green-500',
  clampUsedPercent: (n: number) => Math.max(0, Math.min(100, Math.round(n)))
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: Record<string, unknown>) {
    return { type: 'DropdownMenu', props }
  },
  DropdownMenuContent: function DropdownMenuContent(props: Record<string, unknown>) {
    return { type: 'DropdownMenuContent', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return { type: 'DropdownMenuSeparator', props: {} }
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: Record<string, unknown>) {
    return { type: 'DropdownMenuTrigger', props }
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function findChildByType(node: unknown, typeName: string): ReactElementLike {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current == null || typeof current === 'string' || typeof current === 'number') {
      continue
    }
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }
    const el = current as ReactElementLike
    const type = el.type as { name?: string } | string | undefined
    const matchedName = typeof type === 'string' ? type : type?.name
    if (matchedName === typeName) {
      return el
    }
    if (el.props && 'children' in el.props) {
      stack.push(el.props.children)
    }
  }
  throw new Error(`Could not find ${typeName}`)
}

async function renderProviderDetailsMenu(): Promise<unknown> {
  const { ProviderDetailsMenu } = await import('./StatusBar')
  return ProviderDetailsMenu({
    provider: {
      provider: 'codex',
      status: 'ok',
      error: null,
      updatedAt: Date.now(),
      session: {
        usedPercent: 1,
        resetsAt: Date.now() + 1_000,
        resetDescription: '5h',
        windowMinutes: 300
      },
      weekly: {
        usedPercent: 3,
        resetsAt: Date.now() + 1_000,
        resetDescription: 'wk',
        windowMinutes: 10_080
      }
    },
    compact: false,
    iconOnly: false,
    ariaLabel: 'Open Codex usage details'
  })
}

describe('ProviderDetailsMenu focus handoff', () => {
  it('lets pointer-outside closes keep focus on the clicked surface', async () => {
    const element = await renderProviderDetailsMenu()
    const dropdown = findChildByType(element, 'DropdownMenu')
    const content = findChildByType(element, 'DropdownMenuContent')

    expect(dropdown.props.modal).toBe(false)

    const preventDefault = vi.fn()
    ;(content.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault
    })
    expect(preventDefault).not.toHaveBeenCalled()

    ;(content.props.onPointerDownOutside as () => void)()
    ;(content.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault
    })
    expect(preventDefault).toHaveBeenCalledOnce()

    preventDefault.mockClear()
    ;(content.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault
    })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
