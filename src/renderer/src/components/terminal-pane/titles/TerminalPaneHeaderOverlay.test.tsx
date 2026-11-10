/**
 * @vitest-environment happy-dom
 */
import type * as I18n from '@/i18n/i18n'
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import path from 'node:path'
import { isTerminalLeafId } from '../../../../../shared/workspace-layout/stable-pane-id'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import type { AppState } from '../../../store/types'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  writeWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign((selector: (state: Partial<AppState>) => unknown) => selector({}), {
    getState: () => ({
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1', hostId: 'local', path: '/repo' }] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      sshConnectionStates: new Map()
    })
  })
}))
vi.mock('../input/terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))
vi.mock('../chat/TerminalPaneResumeInChatButton', () => ({
  TerminalPaneResumeInChatButton: () => <button type="button">Continue in Chat UI</button>
}))

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
  canShowTerminal = false,
  canResumeInNewNativeChat = false,
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
  canShowTerminal?: boolean
  canResumeInNewNativeChat?: boolean
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
        canShowTerminal={canShowTerminal}
        onShowTerminal={vi.fn()}
        canResumeInNewNativeChat={canResumeInNewNativeChat}
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
  vi.unstubAllGlobals()
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('TerminalPaneHeaderOverlay', () => {
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
})

function dispatchFileDrag(target: Element, type: 'dragover' | 'drop', internal: boolean): void {
  const payload = new Map([
    [WORKSPACE_FILE_PATHS_MIME, encodeWorkspaceFilePaths(['/repo/file.txt'])]
  ])
  writeWorkspaceFileDragSource(
    { setData: (mime, value) => payload.set(mime, value) },
    { executionHostId: 'local', workspaceId: 'wt-1' }
  )
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: internal ? [WORKSPACE_FILE_PATHS_MIME, WORKSPACE_FILE_DRAG_SOURCE_MIME] : ['Files'],
      files: [new File([], 'file.txt')],
      getData: (mime: string) => (internal ? (payload.get(mime) ?? '') : ''),
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
      vi.stubGlobal('api', {
        fs: {
          getPathForFile: () => '/repo/file.txt',
          prepareDroppedPaths: async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })
        }
      })
      await act(async () => {
        if (dragover) {
          dispatchFileDrag(title, 'dragover', internal)
        }
        dispatchFileDrag(title, 'drop', internal)
      })
      expect(sends[0]).toHaveBeenCalledExactlyOnceWith('/repo/file.txt ', 'driving')
      expect(sends[1]).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
      expect(manager.getActivePane()).toBe(panes[1])
    }
  )
})
