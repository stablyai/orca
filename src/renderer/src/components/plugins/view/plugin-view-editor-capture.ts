import {
  PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS,
  type PluginViewEditorCapture,
  type PluginViewReply
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import {
  pluginEditorCaptureStatus,
  subscribePluginEditorCapture,
  type PluginEditorCaptureStatus
} from '@/components/editor/plugin-editor-capture-status'
import { flushEditorFrames } from '@/components/editor/save/flush/editor-pending-flush'
import { useAppStore } from '@/store'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
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
      const status = pluginEditorCaptureStatus(fileId)
      const met = status !== null && done(status)
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

function editorFrameOf(fileId: string): Element | null {
  const surface = document.querySelector(`[data-plugin-editor-surface="${CSS.escape(fileId)}"]`)
  return surface?.querySelector('webview, iframe') ?? null
}

function measureEditorFrame(fileId: string): Rect | null {
  const frame = editorFrameOf(fileId)
  if (!frame) {
    return null
  }
  const { x, y, width, height } = frame.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** This tab's guest: another tab of the same editor loads the same URL. */
function editorGuestContentsId(fileId: string): number | undefined {
  const frame = editorFrameOf(fileId)
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

const loaded = (status: PluginEditorCaptureStatus): boolean =>
  status.frame === 'ready' && status.delivered

/** Waits for the open file's editor frame to get its document and ask for it, then measures it. */
export async function captureOpenEditor(
  requestId: string,
  fileId: string,
  capture: PluginViewEditorCapture
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
  const load = await waitForPluginEditor(
    fileId,
    (status) =>
      status.frame === 'error' ||
      status.frame === 'unresponsive' ||
      (status.frameKey?.endsWith(`:${loadNumber}`) === true && loaded(status)),
    capture.timeoutMs
  )
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
        (status) => status.subscribed,
        PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS
      )
    : { met: false }
  await waitForColorScheme(wantDark)
  await nextPaintedFrames()
  const rect = measureEditorFrame(fileId)
  if (!rect) {
    return refuse(requestId, 'editor_hidden', 'The editor is not on screen.')
  }
  const dark = document.documentElement.classList.contains('dark')
  const guestUrl = load.status?.guestUrl ?? null
  const guestContentsId = guestUrl ? editorGuestContentsId(fileId) : undefined
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
