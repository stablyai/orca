// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Why mock: react-colorful drives a real canvas-less DOM slider; the contract under test is what
// this popover forwards, not how the wheel computes a hue.
const pickerOnChange = vi.hoisted(() => ({ current: null as ((value: string) => void) | null }))
vi.mock('react-colorful', () => ({
  HexColorPicker: (props: { color: string; onChange: (value: string) => void }) => {
    pickerOnChange.current = props.onChange
    return <div data-testid="wheel" data-color={props.color} />
  }
}))

// Why capture the content props: Escape is delivered by Radix through onEscapeKeyDown, which a DOM
// keydown cannot reach here, so the test invokes it the way Radix would.
type ContentProps = {
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  onPointerDownOutside?: () => void
  onCloseAutoFocus?: (event: Event) => void
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
}
const contentProps = vi.hoisted(() => ({ current: null as null | ContentProps }))
vi.mock('@/components/ui/popover', () => ({
  Popover: (props: { open: boolean; children: React.ReactNode }) =>
    props.open ? <div data-testid="popover">{props.children}</div> : null,
  PopoverAnchor: (props: { children?: React.ReactNode }) => <>{props.children}</>,
  PopoverContent: (props: ContentProps & { children?: React.ReactNode }) => {
    contentProps.current = props
    return (
      <div data-testid="content" onKeyDown={props.onKeyDown}>
        {props.children}
      </div>
    )
  }
}))

import { WorktreeColorTagPickerPopover } from './WorktreeColorTagPickerPopover'
import { type PreviewedWorktree, useWorkspaceColorTagPreview } from './workspace-color-tag-preview'
import { getWorkspaceColorTagIdentity } from '../../../../shared/workspace-color-tag'

const POINT = { x: 0, y: 0 }
const TARGET = { id: 'repo::a', hostId: 'local' } as PreviewedWorktree
const IDENTITY = getWorkspaceColorTagIdentity(TARGET)

type CommitMock = Mock<(colorTag: string | null) => Promise<void>>

// Reads the preview channel the way the card does, so assertions cover the real consumer hook.
let latestPreview: string | null | undefined
function PreviewProbe(): null {
  latestPreview = useWorkspaceColorTagPreview(IDENTITY)
  return null
}

function mount(props: { colorTag: string | null; open?: boolean; onCommitColorTag?: CommitMock }) {
  const onCommitColorTag: CommitMock =
    props.onCommitColorTag ??
    vi.fn<(colorTag: string | null) => Promise<void>>().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  const onRestoreFocus = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <>
        <PreviewProbe />
        <WorktreeColorTagPickerPopover
          open={props.open ?? true}
          colorTag={props.colorTag}
          menuPoint={POINT}
          previewTargets={[TARGET]}
          onOpenChange={onOpenChange}
          onCommitColorTag={onCommitColorTag}
          onRestoreFocus={onRestoreFocus}
        />
      </>
    )
  })
  const input = container.querySelector('input') as HTMLInputElement
  const wheel = container.querySelector('[data-testid="wheel"]') as HTMLElement
  return { root, container, input, wheel, onCommitColorTag, onOpenChange, onRestoreFocus }
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (
    this: HTMLInputElement,
    value: string
  ) => void
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  )
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('WorktreeColorTagPickerPopover', () => {
  let mounted: ReturnType<typeof mount> | null = null
  beforeEach(() => {
    pickerOnChange.current = null
    contentProps.current = null
  })
  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount())
      mounted.container.remove()
      mounted = null
    }
  })

  // Why: a drag previews through the channel the card reads, and writes nothing. On a slow host a
  // per-move write would freeze the card on the first color for the whole round trip.
  it('previews every wheel change on the card without committing', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    expect(latestPreview).toBe('#112233')
    act(() => pickerOnChange.current?.('#445566'))
    expect(latestPreview).toBe('#445566')

    expect(mounted.onCommitColorTag).not.toHaveBeenCalled()
  })

  it('commits the final value exactly once on Enter, clears the preview once it lands, and closes', async () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    act(() => pickerOnChange.current?.('#445566'))
    await act(async () => {
      pressEnter(mounted!.input)
      await settle()
    })

    expect(mounted.onCommitColorTag.mock.calls).toEqual([['#445566']])
    expect(latestPreview).toBeUndefined()
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false)
  })

  // Regression: Enter was handled only on the input, but Radix focuses the wheel first.
  it('commits on Enter from the wheel, not only from the hex field', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    act(() => pressEnter(mounted!.wheel))

    expect(mounted.onCommitColorTag.mock.calls).toEqual([['#112233']])
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false)
  })

  // Regression: the untouched wheel seeds to the first swatch, and an earlier version stamped that
  // seed onto an untagged workspace the moment the popover was dismissed.
  it('commits nothing when opened and closed without a change', () => {
    mounted = mount({ colorTag: null })
    act(() => pressEnter(mounted!.input))

    expect(mounted.onCommitColorTag).not.toHaveBeenCalled()
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false)
  })

  // Regression: Escape reached the same close path as leaving the popover and persisted the edit
  // the user was backing out of.
  it('backs out on Escape without committing and drops the preview', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    expect(latestPreview).toBe('#112233')

    act(() => {
      contentProps.current?.onEscapeKeyDown?.(
        new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      )
    })

    expect(mounted.onCommitColorTag).not.toHaveBeenCalled()
    expect(latestPreview).toBeUndefined()
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not forward a half-typed hex from the input', () => {
    mounted = mount({ colorTag: '#ef4444' })
    act(() => typeInto(mounted!.input, '#ab'))

    expect(mounted.onCommitColorTag).not.toHaveBeenCalled()
    expect(latestPreview).toBeUndefined()
  })

  // Regression: the popover accepted only six digits while the model accepts three, so a standard
  // `#abc` never previewed or persisted.
  it('previews a shorthand hex expanded the way the model stores it', () => {
    mounted = mount({ colorTag: null })
    act(() => typeInto(mounted!.input, '#abc'))

    expect(latestPreview).toBe('#aabbcc')
  })

  it('commits the last complete color when the field is left half-edited on close', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    act(() => typeInto(mounted!.input, '#11'))
    act(() => pressEnter(mounted!.input))

    expect(mounted.onCommitColorTag.mock.calls).toEqual([['#112233']])
  })

  // Regression: the wheel was fed the raw field text, so `#1` and `#12` made it jump or blank
  // while the user typed a replacement.
  it('keeps the wheel on the last complete color while the field holds a partial draft', () => {
    mounted = mount({ colorTag: '#ef4444' })
    act(() => typeInto(mounted!.input, '#1'))
    expect(mounted.wheel.getAttribute('data-color')).toBe('#ef4444')
    expect(mounted.input.value).toBe('#1')

    act(() => typeInto(mounted!.input, '#123456'))
    expect(mounted.wheel.getAttribute('data-color')).toBe('#123456')
  })

  it('falls back to the last wheel color, not the seed, when a typed draft goes partial', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    act(() => typeInto(mounted!.input, '#a'))
    expect(mounted.wheel.getAttribute('data-color')).toBe('#112233')
  })

  // Regression: the preview was cleared the instant the popover closed, but a folder or queued
  // write only reaches the store when it lands, so the card snapped back to its old strip.
  it('holds the preview until the commit has landed, then clears it', async () => {
    let land!: () => void
    const commit: CommitMock = vi.fn<(colorTag: string | null) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        })
    )
    mounted = mount({ colorTag: null, onCommitColorTag: commit })
    act(() => pickerOnChange.current?.('#112233'))
    act(() => pressEnter(mounted!.input))

    expect(commit).toHaveBeenCalledWith('#112233')
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false)
    expect(latestPreview).toBe('#112233')

    await act(async () => {
      land()
      await settle()
    })
    expect(latestPreview).toBeUndefined()
  })

  it('still clears the preview if the commit fails', async () => {
    const commit: CommitMock = vi
      .fn<(colorTag: string | null) => Promise<void>>()
      .mockRejectedValue(new Error('host away'))
    mounted = mount({ colorTag: null, onCommitColorTag: commit })
    act(() => pickerOnChange.current?.('#112233'))
    await act(async () => {
      pressEnter(mounted!.input)
      await settle()
    })
    expect(latestPreview).toBeUndefined()
  })

  it('drops its preview when the card unmounts mid-drag', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    expect(latestPreview).toBe('#112233')

    act(() => mounted?.root.unmount())
    mounted.container.remove()
    mounted = null
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<PreviewProbe />))
    expect(latestPreview).toBeUndefined()
    act(() => root.unmount())
    container.remove()
  })

  // Regression: every card mounts a popover, and a closed bystander's cleanup cleared the previews
  // an open picker on another card was driving.
  it('does not let a closed bystander instance clear an open picker preview', () => {
    mounted = mount({ colorTag: null })
    act(() => pickerOnChange.current?.('#112233'))
    expect(latestPreview).toBe('#112233')

    const bystander = document.createElement('div')
    document.body.appendChild(bystander)
    const bystanderRoot = createRoot(bystander)
    act(() => {
      bystanderRoot.render(
        <WorktreeColorTagPickerPopover
          open={false}
          colorTag={null}
          menuPoint={POINT}
          previewTargets={[TARGET]}
          onOpenChange={vi.fn()}
          onCommitColorTag={vi
            .fn<(colorTag: string | null) => Promise<void>>()
            .mockResolvedValue(undefined)}
          onRestoreFocus={vi.fn()}
        />
      )
    })
    act(() => bystanderRoot.unmount())
    bystander.remove()

    expect(latestPreview).toBe('#112233')
  })

  it('returns focus to the sidebar after a keyboard close', () => {
    mounted = mount({ colorTag: null })
    act(() => pressEnter(mounted!.input))
    const event = new Event('closeAutoFocus', { cancelable: true })
    act(() => contentProps.current?.onCloseAutoFocus?.(event))

    expect(mounted.onRestoreFocus).toHaveBeenCalledWith(event)
  })

  // Regression: every close ran the sidebar focus restore, so a click onto another control — a
  // freshly opened menu, say — had its focus stolen after the exit animation and was dismissed.
  it('leaves focus on the outside target after a pointer dismiss', () => {
    mounted = mount({ colorTag: null })
    act(() => contentProps.current?.onPointerDownOutside?.())
    const event = new Event('closeAutoFocus', { cancelable: true })
    act(() => contentProps.current?.onCloseAutoFocus?.(event))

    expect(mounted.onRestoreFocus).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  // Regression: picker A, closed but holding its preview for a slow write, cleared the card's
  // preview identity-wide when the write landed, erasing picker B's newer live preview.
  it('does not clear a newer preview another picker set when its own slow commit lands', async () => {
    let land!: () => void
    const commit: CommitMock = vi.fn<(colorTag: string | null) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        })
    )
    mounted = mount({ colorTag: null, onCommitColorTag: commit })
    act(() => pickerOnChange.current?.('#111111'))
    act(() => pressEnter(mounted!.input))
    expect(latestPreview).toBe('#111111')

    const other = document.createElement('div')
    document.body.appendChild(other)
    const otherRoot = createRoot(other)
    act(() => {
      otherRoot.render(
        <WorktreeColorTagPickerPopover
          open
          colorTag={null}
          menuPoint={POINT}
          previewTargets={[TARGET]}
          onOpenChange={vi.fn()}
          onCommitColorTag={vi
            .fn<(colorTag: string | null) => Promise<void>>()
            .mockResolvedValue(undefined)}
          onRestoreFocus={vi.fn()}
        />
      )
    })
    act(() => pickerOnChange.current?.('#222222'))
    expect(latestPreview).toBe('#222222')

    await act(async () => {
      land()
      await settle()
    })
    expect(latestPreview).toBe('#222222')

    act(() => otherRoot.unmount())
    other.remove()
    expect(latestPreview).toBeUndefined()
  })

  it('seeds the wheel from the current tag', () => {
    mounted = mount({ colorTag: '#22c55e' })
    expect(mounted.wheel.getAttribute('data-color')).toBe('#22c55e')
  })
})
