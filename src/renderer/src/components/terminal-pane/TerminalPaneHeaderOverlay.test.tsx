/**
 * @vitest-environment happy-dom
 */
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import path from 'node:path'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'
import { handleTerminalFileDrop } from './terminal-drop-handler'
import { resolveNativeFileDropPath } from '../../../../shared/native-file-drop'
import { encodeWorkspaceFilePaths, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'

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
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1', hostId: 'local', path: '/repo' }] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      sshConnectionStates: new Map()
    })
  }
}))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function makePane(id: number): ManagedPane {
  const leafId = `00000000-0000-4000-8000-00000000000${id}`
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Invalid test leaf')
  }
  return {
    id,
    leafId,
    stablePaneId: leafId,
    container: document.createElement('div'),
    linkTooltip: document.createElement('div'),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Drops only call focus on the test terminal.
    terminal: { focus: vi.fn() } as unknown as ManagedPane['terminal'],
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
  isTabPinned = false,
  onClosePane = vi.fn(),
  onRemoveTitle = vi.fn(),
  onRenameSubmit = vi.fn(),
  canContinueAgentSessionInNewSession = false,
  onContinueAgentSessionInNewSession = vi.fn(),
  renameValue = '',
  renamingPaneId = null,
  dropSetup
}: {
  paneTitles: Record<number, string>
  paneCount?: number
  showAlwaysOnHeaders?: boolean
  showSplitButton?: boolean
  isTabPinned?: boolean
  onClosePane?: ReturnType<typeof vi.fn>
  onRemoveTitle?: ReturnType<typeof vi.fn>
  onRenameSubmit?: ReturnType<typeof vi.fn>
  canContinueAgentSessionInNewSession?: boolean
  onContinueAgentSessionInNewSession?: ReturnType<typeof vi.fn>
  renameValue?: string
  renamingPaneId?: number | null
  dropSetup?: {
    panes: ManagedPane[]
    manager: PaneManager
    transports: Map<number, PtyTransport>
    activate: (id: number) => void
  }
}): {
  container: HTMLDivElement
  onClosePane: ReturnType<typeof vi.fn>
  onRemoveTitle: ReturnType<typeof vi.fn>
  onRenameSubmit: ReturnType<typeof vi.fn>
} {
  const panes = dropSetup?.panes ?? [makePane(1), makePane(2)].slice(0, paneCount)
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
        isTabPinned={isTabPinned}
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
        managerRef={{ current: dropSetup?.manager ?? null }}
        paneTransportsRef={{ current: dropSetup?.transports ?? new Map<number, PtyTransport>() }}
        canContinueAgentSessionInNewSession={canContinueAgentSessionInNewSession}
        onContinueAgentSessionInNewSession={
          onContinueAgentSessionInNewSession as (pane: ManagedPane) => void
        }
        onSplitPane={vi.fn()}
        onBeginPaneDrag={vi.fn()}
        onActivatePaneTitleInteraction={dropSetup?.activate ?? vi.fn()}
        onPaneTitleContextMenu={vi.fn()}
        onStartRename={vi.fn()}
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
  return { container, onClosePane, onRemoveTitle, onRenameSubmit }
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
  it('keeps the titled split-pane X as remove-title only', () => {
    const { container, onClosePane, onRemoveTitle } = renderOverlay({
      paneTitles: { 1: 'server', 2: '' }
    })

    const removeTitle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove pane title: server"]'
    )
    expect(removeTitle).not.toBeNull()
    expect(
      container.querySelector('.pane-title-bar[data-active-pane] button[aria-label="Close Pane"]')
    ).toBeNull()

    act(() => removeTitle?.click())

    expect(onRemoveTitle).toHaveBeenCalledWith(1)
    expect(onClosePane).not.toHaveBeenCalled()
  })

  it('offers close tab beside remove-title for a titled single pane', () => {
    const { container, onClosePane, onRemoveTitle } = renderOverlay({
      paneTitles: { 1: 'server' },
      paneCount: 1
    })

    expect(container.querySelector('button[aria-label="Remove pane title: server"]')).not.toBeNull()
    const closeTab = container.querySelector<HTMLButtonElement>('button[aria-label="Close tab"]')
    expect(closeTab).not.toBeNull()

    act(() => closeTab?.click())

    expect(onClosePane).toHaveBeenCalledWith(1)
    expect(onRemoveTitle).not.toHaveBeenCalled()
  })

  it('keeps split and close-pane controls available for untitled split pane headers', () => {
    const { container, onClosePane } = renderOverlay({
      paneTitles: { 1: '', 2: '' }
    })

    expect(container.querySelector('button[aria-label="Split Terminal Right"]')).not.toBeNull()
    expect(container.querySelector('.pane-title-drag-handle')).toBeNull()
    const closePane = container.querySelector<HTMLButtonElement>('button[aria-label="Close Pane"]')
    expect(closePane).not.toBeNull()

    act(() => closePane?.click())

    expect(onClosePane).toHaveBeenCalledWith(1)
  })

  it('offers close tab for an untitled single pane', () => {
    const { container, onClosePane } = renderOverlay({ paneTitles: { 1: '' }, paneCount: 1 })

    const closeTab = container.querySelector<HTMLButtonElement>('button[aria-label="Close tab"]')
    expect(closeTab).not.toBeNull()
    expect(container.querySelector('button[aria-label="Close Pane"]')).toBeNull()

    act(() => closeTab?.click())

    expect(onClosePane).toHaveBeenCalledWith(1)
  })

  it.each([
    { label: 'untitled', title: '' },
    { label: 'titled', title: 'server' }
  ])('keeps a pinned $label single-pane tab without a close button', ({ title }) => {
    const { container } = renderOverlay({
      paneTitles: { 1: title },
      paneCount: 1,
      isTabPinned: true
    })

    expect(container.querySelector('button[aria-label="Close tab"]')).toBeNull()
  })

  it('omits the split control when the header affordance is hidden', () => {
    const { container } = renderOverlay({
      paneTitles: { 1: '', 2: '' },
      paneCount: 1,
      showSplitButton: false
    })

    expect(container.querySelector('button[aria-label="Split Terminal Right"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Close tab"]')).toBeNull()
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
})

function dispatchFileDrag(target: Element, type: 'dragover' | 'drop', internal: boolean): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: internal ? [WORKSPACE_FILE_PATHS_MIME] : ['Files'],
      getData: () => encodeWorkspaceFilePaths(['/repo/file.txt']),
      dropEffect: 'none'
    }
  })
  target.dispatchEvent(event)
}

describe('terminal title drop ownership', () => {
  it.each([
    { internal: true, dragover: true },
    { internal: true, dragover: false },
    { internal: false, dragover: true },
    { internal: false, dragover: false }
  ])(
    'delivers to pane A while B stays active (internal=$internal, dragover=$dragover)',
    async ({ internal, dragover }) => {
      const panes = [makePane(1), makePane(2)]
      let active = panes[1]
      const activate = vi.fn((id: number) => {
        active = panes.find((pane) => pane.id === id) ?? active
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The drop handler only reads panes and the active pane from this manager.
      const manager = { getPanes: () => panes, getActivePane: () => active } as PaneManager
      const sends = [vi.fn(() => true), vi.fn(() => true)]
      const transports = new Map<number, PtyTransport>()
      panes.forEach((pane, index) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every transport method used by local file drops.
        const transport = {
          sendInput: sends[index],
          getPtyId: () => `pty-${pane.id}`,
          isConnected: () => true,
          getExecutionHostId: () => 'local'
        } as unknown as PtyTransport
        transports.set(pane.id, transport)
      })
      const { container } = renderOverlay({
        paneTitles: { 1: 'A', 2: 'B' },
        dropSetup: { panes, manager, transports, activate }
      })
      const title = container.querySelector('.pane-title-bar')
      if (!title) {
        throw new Error('Title A did not render')
      }
      const deliveries: Promise<void>[] = []
      const legacyCapture = (event: Event): void => {
        if (internal) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const entries = event
          .composedPath()
          .filter((entry): entry is HTMLElement => entry instanceof HTMLElement)
          .map((entry) => ({
            nativeFileDropTarget: entry.dataset.nativeFileDropTarget,
            terminalTabId: entry.dataset.terminalTabId,
            terminalPaneLeafId: entry.dataset.terminalPaneLeafId
          }))
        const resolution = resolveNativeFileDropPath(entries)
        if (resolution?.target === 'terminal') {
          deliveries.push(
            handleTerminalFileDrop({
              manager,
              paneTransports: transports,
              worktreeId: 'wt-1',
              tabId: 'tab-1',
              cwd: '/repo',
              data: { paths: ['/repo/file.txt'], ...resolution }
            })
          )
        }
      }
      document.addEventListener('drop', legacyCapture, true)
      try {
        await act(async () => {
          if (dragover) {
            dispatchFileDrag(title, 'dragover', internal)
          }
          dispatchFileDrag(title, 'drop', internal)
          await Promise.all(deliveries)
        })
      } finally {
        document.removeEventListener('drop', legacyCapture, true)
      }
      expect(sends[0]).toHaveBeenCalledExactlyOnceWith('/repo/file.txt ', 'driving')
      expect(sends[1]).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
      expect(manager.getActivePane()).toBe(panes[1])
    }
  )
})
