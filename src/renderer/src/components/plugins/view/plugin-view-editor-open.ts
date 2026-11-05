import {
  PLUGIN_VIEW_NO_WORKSPACE_CODE,
  type PluginViewReply,
  type PluginViewRequest
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import {
  collectActivePluginCustomEditors,
  useCustomEditorViewStore
} from '@/store/plugin-custom-editors'
import { showWorkspaceForFile } from './plugin-view-editor-workspace'
import {
  captureOpenEditor,
  waitForPluginEditor,
  pluginEditorDocumentLoaded,
  pluginEditorStatusMatches,
  pluginEditorFailureApplies
} from './plugin-view-editor-capture'
import { planEditorShotCleanup } from './plugin-view-editor-shot-cleanup'

const fail = (requestId: string, code: string, message: string): PluginViewReply => ({
  requestId,
  ok: false,
  code,
  message
})
const NO_EDITOR_WORKSPACE_MESSAGE =
  'No workspace shows the file, and Orca could not open its folder as a folder workspace.'

export async function openPluginEditor(
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
