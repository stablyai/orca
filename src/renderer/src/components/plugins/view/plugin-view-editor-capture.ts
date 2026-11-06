import {
  PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS,
  type PluginViewEditorCapture,
  type PluginViewReply
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import {
  pluginEditorCaptureStatuses,
  subscribePluginEditorCapture,
  type PluginEditorCaptureStatus
} from '@/components/editor/plugin-editor-capture-status'
import { flushEditorFrames } from '@/components/editor/save/flush/editor-pending-flush'
import { useAppStore } from '@/store'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { nextPaintedFrames, waitForColorScheme } from './plugin-view-panel-settle'

type Rect = { x: number; y: number; width: number; height: number }

/** Resolves with the file's editor status once `done` holds, or at the deadline with what it is. */
export function waitForPluginEditor(
  fileId: string,
  done: (status: PluginEditorCaptureStatus) => boolean,
  timeoutMs: number
): Promise<{ met: boolean; status: PluginEditorCaptureStatus | null }> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (final: boolean): void => {
      const snapshots = pluginEditorCaptureStatuses(fileId)
      const matching = snapshots.find(done)
      const status = matching ?? snapshots[0] ?? null
      const met = matching !== undefined
      if (met || final) {
        clearTimeout(timer)
        unsubscribe()
        resolve({ met, status })
      }
    }
    unsubscribe = subscribePluginEditorCapture(() => check(false))
    timer = setTimeout(() => check(true), timeoutMs)
    check(false)
  })
}

function editorFrameOf(
  fileId: string,
  frameName?: string,
  frameKey?: string | null
): Element | null {
  const selector = `[data-plugin-editor-surface="${CSS.escape(fileId)}"]${frameName ? `[data-plugin-editor-frame="${CSS.escape(frameName)}"]` : ''}${frameKey ? `[data-plugin-editor-frame-key="${CSS.escape(frameKey)}"]` : ''}`
  const surface = document.querySelector(selector)
  return surface?.querySelector('webview, iframe') ?? null
}

function measureEditorFrame(
  fileId: string,
  frameName?: string,
  frameKey?: string | null
): Rect | null {
  const frame = editorFrameOf(fileId, frameName, frameKey)
  if (!frame) {
    return null
  }
  const { x, y, width, height } = frame.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** This tab's guest: another tab of the same editor loads the same URL. */
function editorGuestContentsId(
  fileId: string,
  frameName?: string,
  frameKey?: string | null
): number | undefined {
  const frame = editorFrameOf(fileId, frameName, frameKey)
  if (!frame || !('getWebContentsId' in frame) || typeof frame.getWebContentsId !== 'function') {
    return undefined
  }
  try {
    const id: unknown = frame.getWebContentsId()
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
  } catch {
    // Not attached yet.
    return undefined
  }
}

// Main relays these to the CLI, so they stay English like every other plugin CLI error.
const refuse = (requestId: string, code: string, message: string): PluginViewReply => ({
  requestId,
  ok: false,
  code,
  message
})

export const pluginEditorStatusMatches = (
  status: PluginEditorCaptureStatus,
  editorKey: string
): boolean =>
  status.editorKey === editorKey || status.frameKey?.startsWith(`${editorKey}:`) === true

export const pluginEditorFailureApplies = (
  status: PluginEditorCaptureStatus,
  editorKey?: string
): boolean =>
  status.failure != null &&
  (status.failure.editorKey === undefined ||
    editorKey === undefined ||
    status.failure.editorKey === editorKey)

export const pluginEditorDocumentLoaded = (status: PluginEditorCaptureStatus): boolean =>
  status.frame === 'ready' && status.delivered

/** Waits for the open file's editor frame to get its document and ask for it, then measures it. */
export async function captureOpenEditor(
  requestId: string,
  fileId: string,
  capture: PluginViewEditorCapture,
  editorKey?: string
): Promise<PluginViewReply> {
  // The capture reloads an open editor's frame, so edits still in its debounce window go first.
  if (!(await flushEditorFrames(useAppStore.getState(), fileId))) {
    return refuse(
      requestId,
      'editor_flush_failed',
      'The open editor did not hand over its latest edits, so Orca did not reload it for the shot. Save or wait, then shoot again.'
    )
  }
  const wantDark = capture.colorScheme === undefined ? null : capture.colorScheme === 'dark'
  const size =
    capture.width !== undefined || capture.height !== undefined
      ? { width: capture.width ?? 0, height: capture.height ?? 0 }
      : null
  usePluginViewCaptureStore.getState().begin({
    owner: capture.captureId,
    panelWidth: null,
    dark: wantDark,
    editorFileId: fileId,
    // A missing side keeps the editor's own size along it.
    editorSize: size && {
      width: size.width || (measureEditorFrame(fileId)?.width ?? 800),
      height: size.height || (measureEditorFrame(fileId)?.height ?? 600)
    }
  })
  const loadNumber = usePluginViewCaptureStore.getState().editorLoads[fileId] ?? 0
  const currentGeneration = (status: PluginEditorCaptureStatus): boolean =>
    status.captureId === capture.captureId && status.captureLoad === loadNumber
  const selectedEditor = (status: PluginEditorCaptureStatus): boolean =>
    editorKey === undefined || pluginEditorStatusMatches(status, editorKey)
  const contentFailed = (status: PluginEditorCaptureStatus): boolean =>
    status.contentReady === true &&
    ((status.failure != null && status.failure.editorKey === undefined) ||
      (editorKey !== undefined &&
        status.eligibleEditorKeys !== undefined &&
        !status.eligibleEditorKeys.includes(editorKey)))
  const terminal = (status: PluginEditorCaptureStatus): boolean =>
    currentGeneration(status) &&
    selectedEditor(status) &&
    (pluginEditorFailureApplies(status, editorKey) ||
      status.frame === 'error' ||
      status.frame === 'unresponsive')
  const loaded = (status: PluginEditorCaptureStatus): boolean =>
    currentGeneration(status) && selectedEditor(status) && pluginEditorDocumentLoaded(status)
  const load = await waitForPluginEditor(
    fileId,
    (status) =>
      contentFailed(status) ||
      loaded(status) ||
      (terminal(status) &&
        !pluginEditorCaptureStatuses(fileId).some(
          (sibling) => selectedEditor(sibling) && !terminal(sibling) && !loaded(sibling)
        )),
    capture.timeoutMs
  )
  if (!load.met) {
    return refuse(
      requestId,
      'editor_document_unavailable',
      'The selected editor did not receive its document in time.'
    )
  }
  if (load.status && contentFailed(load.status) && !load.status.failure) {
    return refuse(
      requestId,
      'editor_ineligible',
      'The selected editor can no longer open the loaded document.'
    )
  }
  if (load.status?.failure && pluginEditorFailureApplies(load.status, editorKey)) {
    return refuse(requestId, load.status.failure.code, load.status.failure.message)
  }
  const frame = load.status?.frame
  if (frame === 'error' || frame === 'unresponsive') {
    return {
      requestId,
      ok: false,
      code: 'editor_failed',
      message:
        frame === 'error'
          ? 'The editor could not be loaded.'
          : 'The editor stopped responding to Orca.'
    }
  }
  const subscription = load.met
    ? await waitForPluginEditor(
        fileId,
        (status) =>
          currentGeneration(status) &&
          status.frameName === load.status?.frameName &&
          status.frameKey === load.status?.frameKey &&
          status.subscribed,
        PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS
      )
    : { met: false }
  await waitForColorScheme(wantDark)
  await nextPaintedFrames()
  const currentCapture = usePluginViewCaptureStore.getState()
  const live = pluginEditorCaptureStatuses(fileId).find(
    (status) =>
      loaded(status) &&
      !contentFailed(status) &&
      !pluginEditorFailureApplies(status, editorKey) &&
      status.frameName === load.status?.frameName &&
      status.frameKey === load.status?.frameKey &&
      status.guestUrl === load.status?.guestUrl
  )
  if (
    currentCapture.owner !== capture.captureId ||
    currentCapture.editorLoads[fileId] !== loadNumber ||
    !live
  ) {
    return refuse(
      requestId,
      'editor_changed_during_capture',
      'The editor changed while its capture was being prepared. Try the capture again.'
    )
  }
  const rect = measureEditorFrame(fileId, live.frameName, live.frameKey)
  if (!rect) {
    return refuse(requestId, 'editor_hidden', 'The editor is not on screen.')
  }
  const dark = document.documentElement.classList.contains('dark')
  const guestUrl = live.guestUrl
  const guestContentsId = guestUrl
    ? editorGuestContentsId(fileId, live.frameName, live.frameKey)
    : undefined
  return {
    requestId,
    ok: true,
    panel: {
      rect,
      ui: 'html',
      guestUrl,
      ...(guestUrl ? { guestRect: rect } : {}),
      ...(guestContentsId === undefined ? {} : { guestContentsId }),
      issue: !load.met
        ? 'The editor did not load its document in time.'
        : subscription.met
          ? null
          : `The editor never asked for its document (orca.document.get or onDidChange) within ${PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS / 1000}s.`,
      colorScheme: dark ? 'dark' : 'light',
      themeApplied: wantDark !== null && dark === wantDark,
      settled: load.met,
      subscribed: subscription.met
    }
  }
}
