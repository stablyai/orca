// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DndContext, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import BrowserTab from './BrowserTab'
import EditorFileTab from './EditorFileTab'
import SortableTab from './SortableTab'
import { TabDragPointerSensor } from '../tab-group/tab-drag-pointer-sensor'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { bootWindowFromPartitions } from '../../app-shell/startup-window-view.test-fixture'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  FOLDER_KEY,
  SSH_KEY,
  leaf
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { isTabStripPointerGestureActive } from './tab-strip-pointer-gesture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/runtime/workspace-layout-frame-sync', async (original) => ({
  ...(await original<object>()),
  showStartupLayoutFrames: () => {}
}))

const domWindow = window
const TAB = 'source-unified'
const OTHER = 'other-unified'
const ENTITY = '/repo/source.ts'
const GROUP = 'original-group'
type Kind = 'browser' | 'editor' | 'terminal'
let worktree = GIT_KEY
let stopFrames = () => {}
let drag: string[] = []
let activations = 0
const browser = {
  id: ENTITY,
  worktreeId: GIT_KEY,
  label: 'Source',
  sessionProfileId: null,
  activePageId: 'source-page',
  pageIds: ['source-page'],
  url: 'https://example.com',
  title: 'Source',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
}

function Harness({ kind, singleton }: { kind: Kind; singleton: boolean }) {
  const pane = useRef<HTMLTextAreaElement>(null)
  const sensors = useSensors(
    useSensor(TabDragPointerSensor, {
      activationConstraint: { distance: TAB_DRAG_ACTIVATION_DISTANCE_PX }
    })
  )
  const groups = useAppStore((state) => state.groupsByWorktree[worktree])
  const layout = useAppStore((state) => state.layoutByWorktree[worktree])
  const pinned = useAppStore(
    (state) => state.unifiedTabsByWorktree[worktree]?.find((tab) => tab.id === TAB)?.isPinned
  )
  const common = {
    isActive: false,
    isPinned: pinned === true,
    hasTabsToLeft: false,
    hasTabsToRight: !singleton,
    tabCount: singleton ? 1 : 2,
    onActivate: () => {
      activations += 1
      pane.current?.focus()
    },
    onClose: () => useAppStore.getState().closeUnifiedTab(TAB),
    onCloseOthers: () => {},
    onCloseToLeft: () => {},
    onCloseToRight: () => {},
    onTogglePin: () =>
      (pinned ? useAppStore.getState().unpinTab : useAppStore.getState().pinTab)(TAB),
    dragData: {
      kind: 'tab' as const,
      worktreeId: worktree,
      groupId: GROUP,
      unifiedTabId: TAB,
      visibleTabId: ENTITY,
      tabType: kind,
      label: 'Source'
    }
  }
  return (
    <TooltipProvider>
      <textarea ref={pane} aria-label="Active pane" />
      <DndContext
        sensors={sensors}
        onDragPending={() => drag.push('pending')}
        onDragAbort={() => drag.push('abort')}
        onDragStart={() => drag.push('start')}
        onDragEnd={() => drag.push('end')}
        onDragCancel={() => drag.push('cancel')}
      >
        <SortableContext items={[ENTITY]}>
          {kind === 'browser' ? (
            <BrowserTab
              {...common}
              tab={{ ...browser, worktreeId: worktree }}
              onDuplicate={() =>
                (pinned ? useAppStore.getState().unpinTab : useAppStore.getState().pinTab)(TAB)
              }
            />
          ) : kind === 'editor' ? (
            <EditorFileTab
              {...common}
              gitStatus={null}
              file={{
                id: ENTITY,
                tabId: ENTITY,
                filePath: '/repo/source.ts',
                relativePath: 'source.ts',
                worktreeId: worktree,
                language: 'typescript',
                isDirty: false,
                mode: 'edit'
              }}
              onCloseAll={() => {}}
              onMakePermanent={() => {}}
            />
          ) : (
            <SortableTab
              {...common}
              agent={null}
              tab={{
                id: ENTITY,
                worktreeId: worktree,
                title: 'Source',
                customTitle: null,
                color: null
              }}
              unifiedTabId={TAB}
              groupId={GROUP}
              isExpanded={false}
              onToggleExpand={() => {}}
              onSetCustomTitle={() => {}}
              onSetTabColor={() => {}}
            />
          )}
        </SortableContext>
      </DndContext>
      <output aria-label="Pane layout">{JSON.stringify({ layout, groups })}</output>
    </TooltipProvider>
  )
}
const settle = async () => {
  await act(async () => {
    await layoutApplyTestTransport.settle()
  })
}
async function mount(kind: Kind = 'browser', workspace = GIT_KEY, singleton = false) {
  worktree = workspace
  drag = []
  activations = 0
  const api = createStoreSessionMockApi()
  globalThis.window = domWindow
  Object.assign(window, { api })
  layoutApplyTestTransport.reset()
  const leaves: [string, string][] = [[leaf(1), 'pane-1']]
  const hostId = workspace === SSH_KEY ? 'ssh:fixture-host' : 'local'
  const tabs = [
    kind === 'terminal'
      ? { id: TAB, entityId: ENTITY, leaves }
      : { id: TAB, entityId: ENTITY, kind },
    ...(!singleton ? [{ id: OTHER, entityId: 'other-browser', kind: 'browser' as const }] : [])
  ]
  const session = addWorkspace(
    emptySession(),
    worktree,
    [{ id: GROUP, activeTabId: TAB, tabs }],
    hostId
  )
  session.activeWorktreeId = worktree
  if (kind === 'browser') {
    session.browserTabsByWorktree = { [worktree]: [{ ...browser, worktreeId: worktree }] }
  } else if (kind === 'editor') {
    session.openFilesByWorktree = {
      [worktree]: [
        {
          filePath: ENTITY,
          relativePath: 'source.ts',
          worktreeId: worktree,
          language: 'typescript'
        }
      ]
    }
  }
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel(hostId, session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId, session }])
  const frames = openWorkspaceLayoutFrameSync(useAppStore)
  frames.start()
  stopFrames = () => frames.close()
  await settle()
  return render(<Harness kind={kind} singleton={singleton} />)
}
function source(): HTMLElement {
  const element = document.querySelector(`[data-tab-id="${ENTITY}"]`)
  if (!(element instanceof HTMLElement)) {
    throw new Error('Actual tab missing')
  }
  return element
}
const pointer = (button = 0, buttons = button === 0 ? 1 : 2, y = 16) => ({
  pointerId: 31,
  pointerType: 'mouse',
  isPrimary: true,
  button,
  buttons,
  ctrlKey: button === 0,
  clientX: 40,
  clientY: y
})
function expectStationary(menu: Element | null) {
  expect(menu?.getAttribute('animation')).toBeNull()
  expect(menu?.className).toContain('data-[state=closed]:pointer-events-none')
  expect(menu?.className).not.toMatch(/animate-|fade-|zoom-|slide-|duration-/)
}
async function open(button = 2) {
  fireEvent.pointerDown(source(), pointer(button))
  fireEvent.contextMenu(source(), pointer(button))
  const item = await screen.findByRole('menuitem', { name: /^(Unpin|Pin) Tab$/ })
  expectStationary(screen.getByRole('menu'))
  return item
}
async function right() {
  fireEvent.pointerMove(screen.getByRole('menuitem', { name: 'Move Tab to Split' }), pointer(2))
  const item = await screen.findByRole('menuitem', { name: 'Right' })
  expectStationary(item.closest('[role="menu"]'))
  return item
}
afterEach(async () => {
  fireEvent.pointerCancel(document, pointer())
  cleanup()
  stopFrames()
  endLayoutFramePositions()
  if (vi.isFakeTimers()) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    vi.useRealTimers()
  }
})

it.each(['browser', 'editor', 'terminal'] as const)(
  'settles an opening primary press through the actual %s menu',
  async (kind) => {
    await mount(kind)
    await open(0)
    expect(isTabStripPointerGestureActive()).toBe(false)
    const menu = screen.getByRole('menu')
    // Injected root release models the old capture boundary, not browser hit testing.
    fireEvent.pointerUp(menu, pointer(0, 0))
    fireEvent.pointerMove(document, pointer(0, 0, 60))
    fireEvent.pointerMove(document, pointer(0, 0, 90))
    expect(drag).toEqual(['pending', 'abort'])
    expect(screen.getByRole('menu')).toBe(menu)
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
)

it('retains a large still-held primary drag and settles its release', async () => {
  await mount()
  await open(0)
  // Drive the sensor's existing post-drag click-shield cleanup deterministically.
  vi.useFakeTimers()
  fireEvent.pointerMove(document, pointer(0, 1, 60))
  fireEvent.pointerMove(document, pointer(0, 1, 90))
  expect(drag).toContain('start')
  fireEvent.pointerUp(document, pointer(0, 0, 90))
  fireEvent.pointerMove(document, pointer(0, 0, 120))
  expect(drag.filter((entry) => entry === 'start')).toHaveLength(1)
  expect(drag.at(-1)).toBe('end')
})

it.each([
  ['browser', GIT_KEY],
  ['editor', FOLDER_KEY],
  ['terminal', SSH_KEY]
] as const)(
  'held secondary Right moves the original %s tab to a rendered right group in %s',
  async (kind, workspace) => {
    await mount(kind, workspace)
    await open(2)
    if (kind === 'terminal') {
      fireEvent.pointerMove(screen.getByRole('menuitem', { name: 'Split terminal' }), pointer(2))
      const terminalItem = await screen.findByRole('menuitem', {
        name: /^Split terminal right/i
      })
      expectStationary(terminalItem.closest('[role="menu"]'))
    }
    fireEvent.pointerUp(await right(), pointer(2, 0))
    await settle()
    expect(layoutApplyTestTransport.sentOfType('splitGroup')).toEqual([
      expect.objectContaining({ workspace, tabId: TAB, besideGroupId: GROUP, direction: 'right' })
    ])
    const state = useAppStore.getState()
    const destination = state.unifiedTabsByWorktree[workspace]?.find(
      (tab) => tab.id === TAB
    )?.groupId
    expect(destination).toBeTruthy()
    expect(destination).not.toBe(GROUP)
    expect(
      state.groupsByWorktree[workspace]?.find((group) => group.id === GROUP)?.tabOrder
    ).toEqual([OTHER])
    expect(
      state.groupsByWorktree[workspace]?.find((group) => group.id === destination)?.tabOrder
    ).toEqual([TAB])
    expect(state.layoutByWorktree[workspace]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: GROUP },
      second: { type: 'leaf', groupId: destination }
    })
    expect(screen.getByLabelText('Pane layout').textContent).toContain(destination ?? 'missing')
  }
)

it('supports immediate same-row and cross-row selection after release-before-contextmenu, including singleton first leaf', async () => {
  await mount('browser', GIT_KEY, true)
  fireEvent.pointerDown(source(), pointer(2))
  fireEvent.pointerUp(source(), pointer(2, 0))
  fireEvent.contextMenu(source(), pointer(2, 0))
  expect(screen.queryByRole('menuitem', { name: 'Move Tab to Split' })).toBeNull()
  const pin = await screen.findByRole('menuitem', { name: 'Pin Tab' })
  fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Duplicate Tab' }), pointer())
  fireEvent.pointerUp(pin, pointer(0, 0))
  await waitFor(() =>
    expect(
      useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]?.find((tab) => tab.id === TAB)?.isPinned
    ).toBe(true)
  )
  fireEvent.contextMenu(source(), pointer(2))
  const unpin = await screen.findByRole('menuitem', { name: 'Unpin Tab' })
  fireEvent.pointerDown(unpin, pointer())
  fireEvent.pointerUp(unpin, pointer(0, 0))
  fireEvent.click(unpin)
  // happy-dom requires the compatibility click; this is not browser-click evidence.
  await waitFor(() =>
    expect(
      useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]?.find((tab) => tab.id === TAB)?.isPinned
    ).toBe(false)
  )
})

it('starts editor rename only after menu close autofocus and preserves ordinary dismissal', async () => {
  await mount('editor')
  await open()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Enter' })
  const renameInput = await screen.findByRole('textbox', { name: /Rename file/ })
  await waitFor(() => expect(document.activeElement).toBe(renameInput))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(renameInput.isConnected).toBe(true)
})

// These are renderer event contracts; native/physical ordering remains targeted QA.
it('preserves keyboard selection, outside/blur dismissal and replacement on the actual owner', async () => {
  const view = await mount()
  await open()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Pin Tab' }), { key: ' ' })
  await waitFor(() =>
    expect(
      useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]?.find((tab) => tab.id === TAB)?.isPinned
    ).toBe(true)
  )
  await open()
  fireEvent.pointerDown(screen.getByRole('textbox'), pointer())
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await open()
  fireEvent(window, new Event('blur'))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await open()
  fireEvent.contextMenu(source(), pointer(2))
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  view.unmount()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.pointerUp(document, pointer(2, 0))
  expect(isTabStripPointerGestureActive()).toBe(false)
})

it('keeps primary and Ctrl-primary activation without contextmenu, and middle-close waits for auxclick', async () => {
  await mount()
  for (const ctrlKey of [false, true]) {
    act(() => screen.getByRole('textbox').blur())
    fireEvent.pointerDown(source(), { ...pointer(), ctrlKey })
    fireEvent.pointerUp(source(), { ...pointer(0, 0), ctrlKey })
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    expect(screen.queryByRole('menu')).toBeNull()
  }
  fireEvent.mouseDown(source(), { button: 1 })
  fireEvent.mouseUp(source(), { button: 1 })
  expect(
    useAppStore.getState().groupsByWorktree[GIT_KEY]?.find((group) => group.id === GROUP)?.tabOrder
  ).toEqual([TAB, OTHER])
  fireEvent(source(), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
  await settle()
  expect(
    useAppStore.getState().groupsByWorktree[GIT_KEY]?.find((group) => group.id === GROUP)?.tabOrder
  ).toEqual([OTHER])
  expect(screen.getByLabelText('Pane layout').textContent).not.toContain(TAB)
})

// Reuses the reviewed long-press characterization with correct-result assertions.
it.each([
  ['browser', 'touch'],
  ['editor', 'touch'],
  ['terminal', 'touch'],
  ['browser', 'pen']
] as const)(
  '%s %s fallback opening retires activation while retaining usable menu and sensor settlement',
  async (kind, pointerType) => {
    await mount(kind, GIT_KEY, true)
    vi.useFakeTimers()
    const event = { ...pointer(), pointerType, ctrlKey: false }
    fireEvent.pointerDown(source(), event)
    expect(isTabStripPointerGestureActive()).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(isTabStripPointerGestureActive()).toBe(false)
    expect(activations).toBe(0)
    fireEvent.pointerUp(source(), { ...event, buttons: 0 })
    fireEvent.pointerMove(document, { ...pointer(0, 0, 60), pointerType })
    fireEvent.pointerMove(document, { ...pointer(0, 0, 90), pointerType })
    expect(drag).toEqual(['pending', 'abort'])
    expect(activations).toBe(0)
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
    const pin = screen.getByRole('menuitem', { name: 'Pin Tab' })
    fireEvent.pointerDown(pin, pointer())
    fireEvent.pointerUp(pin, pointer(0, 0))
    fireEvent.click(pin)
    await settle()
    expect(
      useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]?.find((tab) => tab.id === TAB)?.isPinned
    ).toBe(true)
  }
)

it.each([
  ['touch', false],
  ['pen', false],
  ['touch', true],
  ['pen', true]
] as const)(
  'short %s press activates after an open=%s start and clears the primitive timer',
  async (pointerType, alreadyOpen) => {
    await mount('browser', GIT_KEY, true)
    if (alreadyOpen) {
      await open()
    }
    vi.useFakeTimers()
    const event = { ...pointer(), pointerType, ctrlKey: false }
    fireEvent.pointerDown(source(), event)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(isTabStripPointerGestureActive()).toBe(true)
    fireEvent.pointerUp(source(), { ...event, buttons: 0 })
    expect(activations).toBe(1)
    expect(isTabStripPointerGestureActive()).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(activations).toBe(1)
  }
)

it('revalidates original split eligibility when another tab closes with Right already open', async () => {
  await mount()
  await open()
  const item = await right()
  let beforeRelease: string | undefined
  let sentBeforeRelease = 0
  let releasedConnectedItem = false
  const snapshot = () =>
    JSON.stringify({
      groups: useAppStore.getState().groupsByWorktree[worktree],
      layout: useAppStore.getState().layoutByWorktree[worktree],
      tabs: useAppStore.getState().unifiedTabsByWorktree[worktree]
    })
  // Deliver the release at publication of the legitimate close, before React replaces stale content.
  const unsubscribe = useAppStore.subscribe((state) => {
    if (
      beforeRelease ||
      state.groupsByWorktree[worktree]?.find((group) => group.id === GROUP)?.tabOrder.length !== 1
    ) {
      return
    }
    beforeRelease = snapshot()
    sentBeforeRelease = layoutApplyTestTransport.sent.length
    releasedConnectedItem = item.isConnected
    fireEvent.pointerUp(item, pointer(2, 0))
  })
  try {
    act(() => {
      useAppStore.getState().closeUnifiedTab(OTHER)
    })
    await settle()
    expect(releasedConnectedItem).toBe(true)
    expect(beforeRelease).toBeDefined()
    expect(layoutApplyTestTransport.sentOfType('splitGroup')).toEqual([])
    expect(layoutApplyTestTransport.sent).toHaveLength(sentBeforeRelease)
    expect(snapshot()).toBe(beforeRelease)
    expect(
      useAppStore.getState().groupsByWorktree[worktree]?.find((group) => group.id === GROUP)
        ?.tabOrder
    ).toEqual([TAB])
    expect(screen.getByLabelText('Pane layout').textContent).toContain(TAB)
  } finally {
    unsubscribe()
  }
})
