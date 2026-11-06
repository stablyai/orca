import { useCallback, useEffect, useRef } from 'react'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'

/** The open document's eligibility and each mounted editor frame's delivery acknowledgment. */
export type PluginEditorCaptureStatus = {
  frame: 'loading' | 'ready' | 'error' | 'unresponsive'
  guestUrl: string | null
  frameKey: string | null
  frameName?: string
  captureId?: string
  captureLoad?: number
  delivered: boolean
  subscribed: boolean
  editorKey?: string
  filePath?: string
  eligibleEditorKeys?: readonly string[]
  defaultEditorKey?: string | null
  contentReady?: boolean
  failure?: { code: string; message: string; editorKey?: string } | null
}

type ContentStatus = Pick<
  PluginEditorCaptureStatus,
  'filePath' | 'eligibleEditorKeys' | 'defaultEditorKey' | 'failure'
>
type FrameStatus = Omit<PluginEditorCaptureStatus, keyof ContentStatus> &
  Pick<PluginEditorCaptureStatus, 'failure'>
type FileStatus = {
  contentOwners: Map<symbol, ContentStatus>
  frameOwners: Map<symbol, FrameStatus>
  retainedContent?: ContentStatus
  snapshots: PluginEditorCaptureStatus[]
}

const statuses = new Map<string, FileStatus>()
const listeners = new Set<() => void>()
const loading: FrameStatus = {
  frame: 'loading',
  guestUrl: null,
  frameKey: null,
  delivered: false,
  subscribed: false
}

function fileStatus(fileId: string): FileStatus {
  let status = statuses.get(fileId)
  if (!status) {
    status = { contentOwners: new Map(), frameOwners: new Map(), snapshots: [] }
    statuses.set(fileId, status)
  }
  return status
}

function publish(status: FileStatus): void {
  const loaded = [...status.contentOwners.values()].filter(
    (content) => content.eligibleEditorKeys !== undefined
  )
  const content = loaded.at(-1) ?? status.retainedContent
  const frames = [...status.frameOwners.values()].toReversed()
  frames.sort(
    (a, b) =>
      Number(b.frame === 'ready' && b.delivered) - Number(a.frame === 'ready' && a.delivered)
  )
  status.snapshots = (frames.length > 0 ? frames : [loading]).map((frame) => ({
    ...content,
    ...frame,
    contentReady: loaded.length > 0,
    failure: content?.failure ?? frame.failure
  }))
  listeners.forEach((listener) => listener())
}

export function reportPluginEditorContent(
  fileId: string,
  owner: symbol,
  eligibleEditorKeys: readonly string[] | undefined,
  failure: PluginEditorCaptureStatus['failure'] = null,
  filePath?: string,
  defaultEditorKey?: string | null
): void {
  const status = fileStatus(fileId)
  const content = { eligibleEditorKeys, failure, filePath, defaultEditorKey }
  status.contentOwners.delete(owner)
  status.contentOwners.set(owner, content)
  if (eligibleEditorKeys !== undefined) {
    status.retainedContent = content
  }
  publish(status)
}

export function withdrawPluginEditorContent(fileId: string, owner: symbol): void {
  const status = statuses.get(fileId)
  if (status?.contentOwners.delete(owner)) {
    publish(status)
  }
}

/** The canonical file-entity close controller owns pruning, independent of mounted panes. */
export function clearPluginEditorContent(fileId: string): void {
  if (statuses.delete(fileId)) {
    listeners.forEach((listener) => listener())
  }
}

export function withdrawPluginEditorFrame(fileId: string, owner: symbol): void {
  const status = statuses.get(fileId)
  if (status?.frameOwners.delete(owner)) {
    publish(status)
  }
}

export function reportPluginEditorFailure(
  fileId: string,
  owner: symbol,
  code: string,
  message: string,
  editorKey?: string
): void {
  const status = fileStatus(fileId)
  const capture = usePluginViewCaptureStore.getState()
  status.frameOwners.set(owner, {
    ...loading,
    captureId: capture.editorFileId === fileId ? (capture.owner ?? undefined) : undefined,
    captureLoad: capture.editorLoads[fileId] ?? 0,
    frame: 'error',
    editorKey,
    failure: { code, message, editorKey }
  })
  publish(status)
}

export function pluginEditorCaptureStatuses(fileId: string): readonly PluginEditorCaptureStatus[] {
  return statuses.get(fileId)?.snapshots ?? []
}

export function pluginEditorCaptureStatus(fileId: string): PluginEditorCaptureStatus | null {
  return statuses.get(fileId)?.snapshots[0] ?? null
}

export function subscribePluginEditorCapture(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Each mounted frame publishes and withdraws only its own acknowledgment. */
export function usePluginEditorCaptureReport(
  fileId: string | undefined,
  frame: PluginEditorCaptureStatus['frame'],
  guestUrl: string | null,
  frameKey: string | null,
  failure?: PluginEditorCaptureStatus['failure'],
  editorKey?: string,
  frameName?: string
): (step: 'delivered' | 'subscribed') => void {
  const owner = useRef(Symbol('editor-frame')).current
  const failureCode = failure?.code
  const failureMessage = failure?.message
  const failureEditorKey = failure?.editorKey
  const captureId = usePluginViewCaptureStore((state) =>
    state.editorFileId === fileId ? (state.owner ?? undefined) : undefined
  )
  const captureLoad = usePluginViewCaptureStore((state) =>
    fileId === undefined ? 0 : (state.editorLoads[fileId] ?? 0)
  )
  useEffect(() => {
    if (fileId !== undefined) {
      const status = fileStatus(fileId)
      const previous = status.frameOwners.get(owner)
      const sameDocument =
        frame === 'ready' &&
        previous?.frame === 'ready' &&
        previous.frameKey === frameKey &&
        previous.guestUrl === guestUrl &&
        previous.captureLoad === captureLoad
      status.frameOwners.set(owner, {
        frame,
        guestUrl,
        frameKey,
        frameName,
        captureId,
        captureLoad,
        editorKey,
        delivered: sameDocument && previous?.delivered === true,
        subscribed: sameDocument && previous?.subscribed === true,
        failure:
          failureCode !== undefined && failureMessage !== undefined
            ? { code: failureCode, message: failureMessage, editorKey: failureEditorKey }
            : null
      })
      publish(status)
    }
  }, [
    fileId,
    frameKey,
    frame,
    guestUrl,
    failureCode,
    failureMessage,
    failureEditorKey,
    editorKey,
    frameName,
    captureId,
    captureLoad,
    owner
  ])
  useEffect(() => {
    if (fileId !== undefined) {
      return () => withdrawPluginEditorFrame(fileId, owner)
    }
    return undefined
  }, [fileId, owner])
  return useCallback(
    (step) => {
      if (fileId === undefined) {
        return
      }
      const status = statuses.get(fileId)
      const current = status?.frameOwners.get(owner)
      if (status && current) {
        status.frameOwners.set(owner, {
          ...current,
          ...(step === 'delivered' ? { delivered: true } : { subscribed: true })
        })
        publish(status)
      }
    },
    [fileId, owner]
  )
}

/** Capture overrides apply to the open file while each split retains its own frame owner. */
export function usePluginEditorCaptureView(fileId: string | undefined): {
  captureLoad: number
  captureSize: { width: number; height: number } | null
} {
  const captureLoad = usePluginViewCaptureStore((state) =>
    fileId === undefined ? 0 : (state.editorLoads[fileId] ?? 0)
  )
  const captureSize = usePluginViewCaptureStore((state) =>
    fileId !== undefined && state.editorFileId === fileId ? state.editorSize : null
  )
  return { captureLoad, captureSize }
}
