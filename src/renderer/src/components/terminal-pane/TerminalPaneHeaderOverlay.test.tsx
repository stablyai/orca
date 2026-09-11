/**
 * @vitest-environment happy-dom
 */
import { act, createRef, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import type { PtyTransport } from './pty-transport'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'

const { handleInternalTerminalFileDropMock } = vi.hoisted(() => ({
  handleInternalTerminalFileDropMock: vi.fn()
}))

vi.mock('./terminal-drop-handler', () => ({
  handleInternalTerminalFileDrop: handleInternalTerminalFileDropMock
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
const mounted: { container: HTMLDivElement; root: Root }[] = []

function makePane(id: number): ManagedPane {
  const leafId = `leaf-${id}` as ManagedPane['leafId']
  return {
    id,
    leafId,
    stablePaneId: leafId,
    container: document.createElement('div'),
    linkTooltip: document.createElement('div'),
    terminal: {} as ManagedPane['terminal'],
    fitAddon: {} as ManagedPane['fitAddon'],
    searchAddon: {} as ManagedPane['searchAddon'],
    serializeAddon: {} as ManagedPane['serializeAddon']
  }
}

function renderOverlay({
  paneTitles,
  paneCount = 2,
  showAlwaysOnHeaders = true,
  showSplitButton = true,
  onClosePane = vi.fn(),
  onRemoveTitle = vi.fn(),
  onRenameSubmit = vi.fn(),
  onBeginPaneDrag = vi.fn(),
  onStartRename = vi.fn(),
  canContinueAgentSessionInNewSession = false,
  onContinueAgentSessionInNewSession = vi.fn(),
  renameValue = '',
  renamingPaneId = null,
  managerRef = { current: null } as RefObject<PaneManager | null>
}: {
  paneTitles: Record<number, string>
  paneCount?: number
  showAlwaysOnHeaders?: boolean
  showSplitButton?: boolean
  onClosePane?: ReturnType<typeof vi.fn>
  onRemoveTitle?: ReturnType<typeof vi.fn>
  onRenameSubmit?: ReturnType<typeof vi.fn>
  onBeginPaneDrag?: ReturnType<typeof vi.fn>
  onStartRename?: ReturnType<typeof vi.fn>
  canContinueAgentSessionInNewSession?: boolean
  onContinueAgentSessionInNewSession?: ReturnType<typeof vi.fn>
  renameValue?: string
  renamingPaneId?: number | null
  managerRef?: RefObject<PaneManager | null>
}): {
  container: HTMLDivElement
  onClosePane: ReturnType<typeof vi.fn>
  onRemoveTitle: ReturnType<typeof vi.fn>
  onRenameSubmit: ReturnType<typeof vi.fn>
  onBeginPaneDrag: ReturnType<typeof vi.fn>
  onStartRename: ReturnType<typeof vi.fn>
} {
  const panes = [makePane(1), makePane(2)]
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TerminalPaneHeaderOverlay
        tabId="tab-1"
        worktreeId="wt-1"
        cwd={path.join(path.sep, 'tmp')}
        showAlwaysOnHeaders={showAlwaysOnHeaders}
        showSplitButton={showSplitButton}
        paneCount={paneCount}
        activePaneId={1}
        panes={panes}
        paneTitles={paneTitles}
        paneTitleOverlayRects={{
          1: { left: 0, top: 0, width: 200 },
          2: { left: 220, top: 0, width: 200 }
        }}
        renamingPaneId={renamingPaneId}
        renameValue={renameValue}
        renameInputRef={createRef<HTMLInputElement>()}
        titleUsesLightSurface={false}
        paneTitleBackground="transparent"
        terminalContentVisible
        hiddenStartupStyle={{}}
        managerRef={managerRef}
        paneTransportsRef={{ current: new Map() } as RefObject<Map<number, PtyTransport>>}
        canContinueAgentSessionInNewSession={canContinueAgentSessionInNewSession}
        onContinueAgentSessionInNewSession={
          onContinueAgentSessionInNewSession as (pane: ManagedPane) => void
        }
        onSplitPane={vi.fn()}
        onBeginPaneDrag={
          onBeginPaneDrag as (paneId: number, handle: HTMLElement, event: PointerEvent) => void
        }
        onActivatePaneTitleInteraction={vi.fn()}
        onPaneTitleContextMenu={vi.fn()}
        onStartRename={onStartRename as (paneId: number) => void}
        onRemoveTitle={onRemoveTitle as (paneId: number) => void}
        onClosePane={onClosePane as (paneId: number) => void}
        onRenameValueChange={vi.fn()}
        onRenameSubmit={onRenameSubmit as () => void}
        onRenameCancel={vi.fn()}
        onRenameBlur={vi.fn()}
      />
    )
  })
  mounted.push({ container, root })
  return { container, onClosePane, onRemoveTitle, onRenameSubmit, onBeginPaneDrag, onStartRename }
}

function firePointerDown(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })
    )
  })
}

function pressInputKey(
  input: HTMLInputElement,
  key: string,
  options?: { isComposing?: boolean; keyCode?: number }
): void {
  act(() => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true })
    if (options?.isComposing !== undefined) {
      Object.defineProperty(event, 'isComposing', { value: options.isComposing })
    }
    if (options?.keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', { value: options.keyCode })
    }
    input.dispatchEvent(event)
  })
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('TerminalPaneHeaderOverlay', () => {
  it('keeps the titled-pane close affordance as remove-title while headers are always on', () => {
    const { container, onClosePane, onRemoveTitle } = renderOverlay({
      paneTitles: { 1: 'server', 2: '' }
    })

    const removeTitle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove pane title: server"]'
    )
    expect(removeTitle).not.toBeNull()

    act(() => removeTitle?.click())

    expect(onRemoveTitle).toHaveBeenCalledWith(1)
    expect(onClosePane).not.toHaveBeenCalledWith(1)
  })

  it('keeps split and close-pane controls available for untitled split pane headers', () => {
    const { container, onClosePane, onRemoveTitle } = renderOverlay({
      paneTitles: { 1: '', 2: '' }
    })

    expect(container.querySelector('button[aria-label="Split Terminal Right"]')).not.toBeNull()
    expect(container.querySelector('.pane-title-drag-handle')).toBeNull()
    const closePane = container.querySelector<HTMLButtonElement>('button[aria-label="Close Pane"]')
    expect(closePane).not.toBeNull()

    act(() => closePane?.click())

    expect(onClosePane).toHaveBeenCalledWith(1)
    expect(onRemoveTitle).not.toHaveBeenCalled()
  })

  it('omits the split control when the header affordance is hidden', () => {
    const { container } = renderOverlay({
      paneTitles: { 1: '', 2: '' },
      paneCount: 1,
      showSplitButton: false
    })

    expect(container.querySelector('button[aria-label="Split Terminal Right"]')).toBeNull()
  })

  it('ignores IME composition Enter before submitting a pane title rename', () => {
    const { container, onRenameSubmit } = renderOverlay({
      paneTitles: { 1: 'server', 2: '' },
      renamingPaneId: 1,
      renameValue: '日本語 pane'
    })
    const input = container.querySelector<HTMLInputElement>('.pane-title-input')

    expect(input).not.toBeNull()

    pressInputKey(input as HTMLInputElement, 'Enter', { isComposing: true })

    expect(onRenameSubmit).not.toHaveBeenCalled()

    pressInputKey(input as HTMLInputElement, 'Enter')

    expect(onRenameSubmit).toHaveBeenCalledTimes(1)
  })

  it('shows new-session continuation on the active agent pane header', () => {
    const onContinueAgentSessionInNewSession = vi.fn()
    const { container } = renderOverlay({
      paneTitles: { 1: '', 2: '' },
      canContinueAgentSessionInNewSession: true,
      onContinueAgentSessionInNewSession
    })
    const handoff = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Continue in New Session…"]'
    )

    expect(handoff).not.toBeNull()
    act(() => handoff?.click())

    expect(onContinueAgentSessionInNewSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 })
    )
  })

  // Regression for https://github.com/stablyai/orca/issues/19727: once a pane
  // has a title, its .pane-title-bar becomes pointer-events:auto and fully
  // occludes the pane's underlying full-width drag strip. These tests pin the
  // fix's contract: the bar (including the title text, which is a plain drag
  // surface renamed only via double-click) starts the pane drag on
  // pointerdown, while the rename input and every action button opt out via
  // stopPropagation so their own rename/close behavior is preserved — mirrors
  // SortableTab.tsx's tab-label/rename-input split.
  describe('pane drag after a title is set', () => {
    it('starts a pane drag from pointerdown on the titled bar itself', () => {
      const { container, onBeginPaneDrag } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const bar = container.querySelectorAll('.pane-title-bar')[0] as HTMLElement

      firePointerDown(bar)

      expect(onBeginPaneDrag).toHaveBeenCalledTimes(1)
      expect(onBeginPaneDrag).toHaveBeenCalledWith(1, bar, expect.any(PointerEvent))
    })

    it('starts a pane drag from pointerdown on the title text (single click/drag drags; double-click renames)', () => {
      const { container, onBeginPaneDrag } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const titleText = container.querySelector<HTMLSpanElement>('.pane-title-text')

      expect(titleText).not.toBeNull()
      firePointerDown(titleText as HTMLSpanElement)

      expect(onBeginPaneDrag).toHaveBeenCalledTimes(1)
      expect(onBeginPaneDrag).toHaveBeenCalledWith(
        1,
        expect.any(HTMLElement),
        expect.any(PointerEvent)
      )
    })

    it('opens rename on double-click of the title text instead of a single click', () => {
      const { container, onStartRename } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const titleText = container.querySelector<HTMLSpanElement>('.pane-title-text')

      expect(titleText).not.toBeNull()
      // Why: a plain click on the title text (or anywhere else on the bar) must
      // never rename — only pointer movement (drag) or dblclick does anything.
      act(() => titleText?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(onStartRename).not.toHaveBeenCalled()

      // Why: dispatched on the title text and asserted via bubbling, matching
      // production — beginPaneDragFromPointerDown captures the pointer on the
      // bar itself, so the real dblclick actually lands on the bar, not this
      // child; the rename handler lives there for exactly that reason.
      act(() => titleText?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
      expect(onStartRename).toHaveBeenCalledWith(1)
    })

    it('does not open rename on double-click of an action button', () => {
      // Why: an action button's pointerdown stops propagation, so the bar never
      // captures the pointer for that gesture — its native dblclick is a
      // separate event the click handler's stopPropagation doesn't touch, and
      // would otherwise bubble up and incorrectly trigger rename.
      const { container, onStartRename } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const removeTitle = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove pane title: server"]'
      )

      expect(removeTitle).not.toBeNull()
      act(() => removeTitle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))

      expect(onStartRename).not.toHaveBeenCalled()
    })

    it('does not start a pane drag from pointerdown on the rename input', () => {
      const { container, onBeginPaneDrag } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' },
        renamingPaneId: 1,
        renameValue: 'server'
      })
      const input = container.querySelector<HTMLInputElement>('.pane-title-input')

      expect(input).not.toBeNull()
      firePointerDown(input as HTMLInputElement)

      expect(onBeginPaneDrag).not.toHaveBeenCalled()
    })

    it('does not start a pane drag from pointerdown on the split action button', () => {
      const { container, onBeginPaneDrag } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const splitButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Split Terminal Right"]'
      )

      expect(splitButton).not.toBeNull()
      firePointerDown(splitButton as HTMLButtonElement)

      expect(onBeginPaneDrag).not.toHaveBeenCalled()
    })

    it('does not start a pane drag from pointerdown on the remove-title action button', () => {
      const { container, onBeginPaneDrag } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' }
      })
      const removeTitle = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove pane title: server"]'
      )

      expect(removeTitle).not.toBeNull()
      firePointerDown(removeTitle as HTMLButtonElement)

      expect(onBeginPaneDrag).not.toHaveBeenCalled()
    })

    it('still accepts an external workspace-file drag-over/drop on the titled bar', () => {
      const manager = {} as PaneManager
      const { container } = renderOverlay({
        paneTitles: { 1: 'server', 2: '' },
        managerRef: { current: manager } as RefObject<PaneManager | null>
      })
      const bar = container.querySelectorAll('.pane-title-bar')[0] as HTMLElement

      // Why: happy-dom's DragEvent constructor doesn't wire the `dataTransfer`
      // option through (a known limitation), so attach it directly.
      const dataTransfer = new DataTransfer()
      dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, '/tmp/example.txt')
      const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(dragOverEvent, 'dataTransfer', { value: dataTransfer })
      act(() => bar.dispatchEvent(dragOverEvent))
      expect(dragOverEvent.defaultPrevented).toBe(true)
      expect(dataTransfer.dropEffect).toBe('copy')

      const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer })
      act(() => bar.dispatchEvent(dropEvent))
      expect(handleInternalTerminalFileDropMock).toHaveBeenCalledTimes(1)
    })
  })
})
