import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDriverOverlay } from './MobileDriverOverlay'

type OverlayProps = {
  actionLabel: string
  actionPending: boolean
  allActionLabel?: string
  allActionPending?: boolean
  onAction: () => void | Promise<void>
  onAllAction?: () => void | Promise<void>
  rootRef: (node: HTMLDivElement | null) => void
}

type OverlayElement = React.ReactElement<OverlayProps>

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  id: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback
    },
    useId(): string {
      hookRuntime.id += 1
      return `test-id-${hookRuntime.id}`
    },
    useRef<T>(initial: T) {
      const refIndex = hookRuntime.refIndex++
      if (!(refIndex in hookRuntime.refs)) {
        hookRuntime.refs[refIndex] = { current: initial }
      }
      return hookRuntime.refs[refIndex] as { current: T }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = hookRuntime.stateIndex++
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

function renderOverlay(
  onAction: () => void | Promise<void>,
  onAllAction?: () => void | Promise<void>
): OverlayElement {
  hookRuntime.stateIndex = 0
  hookRuntime.refIndex = 0
  return MobileDriverOverlay({
    driver: { kind: 'mobile', clientId: 'phone-1' } as never,
    hasFitOverride: false,
    onAction,
    onAllAction
  }) as OverlayElement
}

describe('MobileDriverOverlay', () => {
  beforeEach(() => {
    hookRuntime.states = []
    hookRuntime.stateIndex = 0
    hookRuntime.refs = []
    hookRuntime.refIndex = 0
    hookRuntime.id = 0
  })

  it('clears stale pending action state when the overlay root reattaches', async () => {
    let currentRootRef: OverlayProps['rootRef'] | null = null
    const onAction = vi.fn(async () => {
      currentRootRef?.(null)
    })

    let overlay = renderOverlay(onAction)
    currentRootRef = overlay.props.rootRef
    currentRootRef({} as HTMLDivElement)

    await overlay.props.onAction()

    overlay = renderOverlay(onAction)
    expect(overlay.props.actionPending).toBe(true)

    currentRootRef = overlay.props.rootRef
    currentRootRef({} as HTMLDivElement)
    overlay = renderOverlay(onAction)

    expect(overlay.props.actionPending).toBe(false)
  })

  it('exposes held-fit restore labels for single and all terminals', () => {
    hookRuntime.stateIndex = 0
    hookRuntime.refIndex = 0

    const overlay = MobileDriverOverlay({
      driver: { kind: 'idle' } as never,
      hasFitOverride: true,
      onAction: vi.fn(),
      onAllAction: vi.fn()
    }) as OverlayElement

    expect(overlay.props.actionLabel).toBe('Restore this terminal')
    expect(overlay.props.allActionLabel).toBe('Restore all terminals')
  })

  it('exposes an all-terminals restore action when provided', async () => {
    const onAction = vi.fn()
    const onAllAction = vi.fn()

    const overlay = renderOverlay(onAction, onAllAction)

    expect(overlay.props.actionLabel).toBe('Take back this terminal')
    expect(overlay.props.allActionLabel).toBe('Take back all terminals')
    expect(overlay.props.allActionPending).toBe(false)
    await overlay.props.onAllAction?.()

    expect(onAction).not.toHaveBeenCalled()
    expect(onAllAction).toHaveBeenCalledOnce()
  })
})
