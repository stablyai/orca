import type { MutableRefObject } from 'react'

export function cancelMarkdownPreviewEditorRevealFrames(
  frameIds: MutableRefObject<number[]>
): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

export function requestMarkdownPreviewEditorRevealFrame(
  frameIds: MutableRefObject<number[]>,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      frameIds.current = frameIds.current.filter((pendingFrameId) => pendingFrameId !== frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    frameIds.current.push(frameId)
  }
}

export function parseMarkdownPreviewLineTarget(
  hash: string
): { line: number; column?: number } | null {
  if (!hash) {
    return null
  }
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return { line: Number(match[1]), column: match[2] ? Number(match[2]) : undefined }
}
