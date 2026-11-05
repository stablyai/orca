import { pluginPanelTabKey } from '../../../../../shared/plugins/frames/plugin-tab-key'
import {
  PLUGIN_VIEW_NO_WORKSPACE_CODE,
  PLUGIN_VIEW_NOT_SHOWN_CODE,
  type PluginViewCapture,
  type PluginViewReply,
  type PluginViewRequest
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import {
  collectActivePluginCustomEditors,
  useCustomEditorViewStore
} from '@/store/plugin-custom-editors'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import {
  measurePluginPanelGuest,
  measurePluginPanelSurface,
  nextPaintedFrames,
  waitForColorScheme,
  waitForPluginPanelDraw
} from './plugin-view-panel-settle'
import { restoreActedPanel, settleAndActOnPanel } from './plugin-view-capture-acts'
import { pluginPanelNotShownReason } from './plugin-view-shown'
import { endPluginShotReplay, replayPluginPanel } from './plugin-view-replay'
import { showWorkspaceForFile } from './plugin-view-editor-workspace'
import {
  captureOpenEditor,
  waitForPluginEditor,
  pluginEditorDocumentLoaded,
  pluginEditorStatusMatches,
  pluginEditorFailureApplies
} from './plugin-view-editor-capture'
import { planEditorShotCleanup, runEditorShotCleanup } from './plugin-view-editor-shot-cleanup'
import { captureChrome } from './plugin-view-chrome-capture'
import { pickWorkspaceToShow } from './plugin-view-workspace-pick'
import {
  openFolderWorkspace,
  openWorkspaceFile,
  runBuiltInAction
} from './plugin-view-host-actions'

type Failure = Extract<PluginViewReply, { ok: false }>

const fail = (requestId: string, code: string, message: string): Failure => ({
  requestId,
  ok: false,
  code,
  message
})

const NO_WORKSPACE_MESSAGE =
  'Orca shows plugin panels and editors beside an open workspace, and none is showing or could be selected.'
const NO_EDITOR_WORKSPACE_MESSAGE =
  'No workspace shows the file, and Orca could not open its folder as a folder workspace.'

/** `open` may leave Settings for the workspace behind it; a capture never changes the view. */
function showWorkspace(requestId: string, leaveSettings: boolean): Failure | null {
  const state = useAppStore.getState()
  if (leaveSettings && state.activeView === 'settings') {
    state.closeSettingsPage()
  }
  const shown = useAppStore.getState()
  const pick =
    canShowRightSidebarForView(shown.activeView) && !shown.activeWorktreeId
      ? pickWorkspaceToShow(selectWorktreesByRepo(shown), selectFolderWorkspaces(shown))
      : null
  if (pick) {
    // Renderer state only: the hidden window stays hidden, and no terminal is started.
    activateAndRevealWorkspace(pick, {
      providesInitialSurface: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  const next = useAppStore.getState()
  if (!canShowRightSidebarForView(next.activeView) || !next.activeWorktreeId) {
    return fail(requestId, PLUGIN_VIEW_NO_WORKSPACE_CODE, NO_WORKSPACE_MESSAGE)
  }
  return null
}

async function openPanel(
  request: Extract<PluginViewRequest, { kind: 'open-panel' }>
): Promise<PluginViewReply> {
  const { requestId, pluginKey, panelId, capture } = request
  // Why fetch first: a folder `dev load` just added is not in this window's list yet.
  await usePluginPanelsStore.getState().fetchPlugins()
  const tabKey = pluginPanelTabKey(pluginKey, panelId)
  const known = usePluginPanelsStore
    .getState()
    .plugins.some(
      (plugin) =>
        plugin.pluginKey === pluginKey && plugin.panels.some((panel) => panel.tabKey === tabKey)
    )
  if (!known) {
    return fail(requestId, 'panel_unavailable', `This window does not list ${tabKey} yet.`)
  }
  if (capture?.ifShown) {
    // Never open or switch: the person may have moved on to another tab.
    const away = pluginPanelNotShownReason(useAppStore.getState(), tabKey)
    return away
      ? fail(requestId, PLUGIN_VIEW_NOT_SHOWN_CODE, away)
      : capturePanel(requestId, tabKey, capture)
  }
  const blocked = showWorkspace(requestId, capture === undefined)
  if (blocked) {
    return blocked
  }
  const state = useAppStore.getState()
  state.setRightSidebarTab(tabKey)
  state.setRightSidebarOpen(true)
  if (!capture) {
    return { requestId, ok: true }
  }
  return capturePanel(requestId, tabKey, capture)
}

async function capturePanel(
  requestId: string,
  tabKey: string,
  capture: PluginViewCapture
): Promise<PluginViewReply> {
  const wantDark = capture.colorScheme === undefined ? null : capture.colorScheme === 'dark'
  usePluginViewCaptureStore.getState().begin({
    panelWidth: capture.width ?? null,
    dark: wantDark,
    ...(capture.captureId === undefined ? {} : { owner: capture.captureId })
  })
  const status = await waitForPluginPanelDraw(tabKey, capture.guestRevision, capture.timeoutMs)
  if (status.value?.failure) {
    return fail(requestId, 'panel_failed', `The plugin panel ${status.value.failure}.`)
  }
  await waitForColorScheme(wantDark)
  const prepared = await settleAndActOnPanel(tabKey, status.value?.ui, capture.acts)
  if (!prepared.ok) {
    return fail(requestId, 'act_unsupported', 'Only a drawn components panel takes --act.')
  }
  let rect = measurePluginPanelSurface(tabKey)
  // The panel sits inside the sidebar's border; one correction makes it exactly --width wide.
  if (rect && capture.width !== undefined && Math.round(rect.width) !== capture.width) {
    usePluginViewCaptureStore
      .getState()
      .setPanelWidth(capture.width + (capture.width - Math.round(rect.width)))
    // A resize relayouts the panel; let it paint before main captures.
    await nextPaintedFrames()
    await nextPaintedFrames()
    rect = measurePluginPanelSurface(tabKey)
  }
  if (!rect) {
    return fail(requestId, 'panel_hidden', 'The plugin panel is not on screen.')
  }
  const dark = document.documentElement.classList.contains('dark')
  const guestRect = status.value?.ui === 'html' ? measurePluginPanelGuest(tabKey) : null
  return {
    requestId,
    ok: true,
    panel: {
      rect,
      ui: status.value?.ui ?? 'components',
      guestUrl: status.value?.guestUrl ?? null,
      ...(guestRect ? { guestRect } : {}),
      issue: status.value?.issue ?? null,
      colorScheme: dark ? 'dark' : 'light',
      themeApplied: wantDark !== null && dark === wantDark,
      settled: status.settled,
      ...(prepared.pendingRequests === undefined
        ? {}
        : { pendingRequests: prepared.pendingRequests }),
      ...(prepared.actions ? { actions: prepared.actions } : {})
    }
  }
}

async function openEditor(
  request: Extract<PluginViewRequest, { kind: 'open-editor' }>
): Promise<PluginViewReply> {
  const { requestId, pluginKey, editorId, filePath, capture } = request
  await usePluginPanelsStore.getState().fetchPlugins()
  const editors = collectActivePluginCustomEditors(usePluginPanelsStore.getState().plugins)
  const editor = editors.find((entry) => entry.pluginKey === pluginKey && entry.id === editorId)
  if (!editor) {
    return fail(
      requestId,
      'editor_unavailable',
      `This window does not list ${pluginKey}/${editorId} yet.`
    )
  }
  if (useAppStore.getState().activeView === 'settings') {
    useAppStore.getState().closeSettingsPage()
  }
  const previousWorktreeId = useAppStore.getState().activeWorktreeId
  const paths = [filePath, ...(request.filePathAliases ?? [])]
  const workspace = await showWorkspaceForFile(paths, request.fallbackFolder)
  if (!workspace) {
    return fail(requestId, PLUGIN_VIEW_NO_WORKSPACE_CODE, NO_EDITOR_WORKSPACE_MESSAGE)
  }
  const openBefore = new Set(useAppStore.getState().openFiles.map((file) => file.id))
  const fileId = useAppStore.getState().openFile(
    {
      filePath: workspace.filePath,
      relativePath: workspace.relativePath,
      worktreeId: workspace.worktreeId,
      language: detectLanguage(workspace.filePath),
      mode: 'edit'
    },
    { preview: false }
  )
  if (capture) {
    planEditorShotCleanup(capture.captureId, {
      fileId,
      openedByShot: !openBefore.has(fileId) && !capture.keepOpen,
      scratchRepoId: capture.scratch ? (workspace.addedRepoId ?? null) : null,
      previousWorktreeId
    })
  }
  const timeoutMs = capture?.timeoutMs ?? 8_000
  const deadline = Date.now() + timeoutMs
  const remaining = (): number => Math.max(0, deadline - Date.now())
  const content = await waitForPluginEditor(
    fileId,
    (status) =>
      status.contentReady === true &&
      status.filePath === workspace.filePath &&
      ((status.failure != null && status.failure.editorKey === undefined) ||
        status.eligibleEditorKeys !== undefined),
    remaining()
  )
  if (content.status?.failure && content.status.failure.editorKey === undefined) {
    return fail(requestId, content.status.failure.code, content.status.failure.message)
  }
  if (!content.met) {
    return fail(
      requestId,
      'editor_read_failed',
      'The file could not be loaded for the editor in time.'
    )
  }
  const eligibleKeys = content.status?.eligibleEditorKeys ?? []
  const selected =
    editors.find((entry) => entry.key === editor.key && eligibleKeys.includes(entry.key)) ??
    editors.find((entry) => entry.pluginKey === pluginKey && eligibleKeys.includes(entry.key))
  if (!selected) {
    return fail(
      requestId,
      'editor_ineligible',
      'No editor from this plugin can open the loaded document.'
    )
  }
  useCustomEditorViewStore.getState().setChoice(fileId, selected.key)
  if (!capture) {
    const opened = await waitForPluginEditor(
      fileId,
      (status) =>
        pluginEditorFailureApplies(status, selected.key) ||
        (pluginEditorStatusMatches(status, selected.key) &&
          (status.frame === 'error' ||
            status.frame === 'unresponsive' ||
            pluginEditorDocumentLoaded(status))),
      remaining()
    )
    if (opened.status?.failure && pluginEditorFailureApplies(opened.status, selected.key)) {
      return fail(requestId, opened.status.failure.code, opened.status.failure.message)
    }
    if (!opened.met || opened.status?.frame !== 'ready') {
      return fail(
        requestId,
        'editor_document_unavailable',
        'The selected editor could not load its document.'
      )
    }
    return { requestId, ok: true, editor: { id: selected.id, title: selected.title } }
  }
  const reply = await captureOpenEditor(
    requestId,
    fileId,
    { ...capture, timeoutMs: remaining() },
    selected.key
  )
  return reply.ok ? { ...reply, editor: { id: selected.id, title: selected.title } } : reply
}

export async function handlePluginViewRequest(
  request: PluginViewRequest
): Promise<PluginViewReply> {
  try {
    switch (request.kind) {
      case 'open-panel':
        return await openPanel(request)
      case 'open-editor':
        return await openEditor(request)
      case 'replay-panel':
        return await replayPluginPanel(request)
      case 'capture-chrome':
        return await captureChrome(request)
      case 'open-file':
        return openWorkspaceFile(request)
      case 'run-action':
        return runBuiltInAction(request)
      case 'open-folder-workspace':
        return openFolderWorkspace(request)
      case 'end-capture': {
        endPluginShotReplay()
        usePluginViewCaptureStore.getState().end(request.captureId)
        await runEditorShotCleanup(request.captureId)
        const restored = await restoreActedPanel()
        return {
          requestId: request.requestId,
          ok: true,
          ...(restored === undefined ? {} : { restored })
        }
      }
    }
  } catch (error) {
    return fail(
      request.requestId,
      'renderer_error',
      error instanceof Error ? error.message : String(error)
    )
  }
}
