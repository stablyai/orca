// The picker's intake: the file chooser, and image paste and drop anywhere in its dialog or popover.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  avatarPngFromBlob,
  BotAvatarIntakeFailure,
  droppedAvatarSource,
  isAvatarDrag,
  pastedAvatarSource,
  type BotAvatarIntakeError
} from './bot-avatar-intake'

/** What the line under the carousel says. */
export type BotAvatarIntakeLine =
  | { kind: 'hint' }
  | { kind: 'drop' }
  | { kind: 'saved' }
  | { kind: 'error'; error: BotAvatarIntakeError }

const HINT: BotAvatarIntakeLine = { kind: 'hint' }
const SAVED_MS = 8_000
const ERROR_MS = 8_000

/** Marks the dialog or popover while a picture is dragged over it. */
export const BOT_PICTURE_DROP_ATTRIBUTE = 'data-bot-picture-drop'

export function useBotAvatarIntake({
  rootRef,
  onPicture,
  undoable
}: {
  /** The picker; paste and drop are taken from the dialog or popover around it. */
  rootRef: React.RefObject<HTMLElement | null>
  onPicture: (png: string) => void
  /** The picture saves at once, so "Picture updated · Undo" follows it. */
  undoable: boolean
}): {
  line: BotAvatarIntakeLine
  /** The intake's own target outline is drawn by the picker, not the popover around it. */
  outlinePicker: boolean
  take: (image: Blob) => void
  /** Back to the hint; a decode in flight is dropped. */
  dismiss: () => void
} {
  const [line, setLineState] = useState<BotAvatarIntakeLine>(HINT)
  const [outlinePicker, setOutlinePicker] = useState(true)
  // Bumped by every new action, so a late decode is dropped.
  const run = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A decode can finish after the carousel moved; the picture lands where it is now.
  const latest = useRef({ onPicture, undoable })
  useEffect(() => {
    latest.current = { onPicture, undoable }
  })

  const setLine = (next: BotAvatarIntakeLine, resetAfterMs?: number): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setLineState(next)
    if (resetAfterMs) {
      timer.current = setTimeout(() => setLineState(HINT), resetAfterMs)
    }
  }

  const dismiss = (): void => {
    run.current += 1
    setLine(HINT)
  }

  const take = (image: Blob): void => {
    run.current += 1
    const id = run.current
    setLine(HINT)
    void avatarPngFromBlob(image).then(
      (png) => {
        if (run.current !== id) {
          return
        }
        latest.current.onPicture(png)
        if (latest.current.undoable) {
          setLine({ kind: 'saved' }, SAVED_MS)
        } else {
          setLine(HINT)
        }
      },
      (error: unknown) => {
        if (run.current === id && error instanceof BotAvatarIntakeFailure) {
          setLine({ kind: 'error', error: error.error }, ERROR_MS)
        }
      }
    )
  }
  const takeFromHost = useEffectEvent(take)

  const setDragging = useEffectEvent((dragging: boolean): void => {
    if (dragging) {
      run.current += 1
      setLine({ kind: 'drop' })
    } else {
      setLineState((current) => (current.kind === 'drop' ? HINT : current))
    }
  })

  useEffect(() => {
    const root = rootRef.current
    const host = root?.closest<HTMLElement>('[role="dialog"]') ?? root
    if (!root || !host) {
      return
    }
    // In a popover the popover itself is the outline; in a dialog the picker is.
    setOutlinePicker(host.dataset.slot !== 'popover-content')
    let depth = 0
    const leave = (): void => {
      depth = 0
      host.removeAttribute(BOT_PICTURE_DROP_ATTRIBUTE)
      setDragging(false)
    }
    const onPaste = (event: ClipboardEvent): void => {
      const image = pastedAvatarSource(event.clipboardData)
      if (image) {
        event.preventDefault()
        event.stopPropagation()
        takeFromHost(image)
      }
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!isAvatarDrag(event.dataTransfer?.types)) {
        return
      }
      depth += 1
      if (depth === 1) {
        host.setAttribute(BOT_PICTURE_DROP_ATTRIBUTE, '')
        setDragging(true)
      }
    }
    const onDragOver = (event: DragEvent): void => {
      if (!isAvatarDrag(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!isAvatarDrag(event.dataTransfer?.types)) {
        return
      }
      depth -= 1
      if (depth <= 0) {
        leave()
      }
    }
    const onDrop = (event: DragEvent): void => {
      if (!isAvatarDrag(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      leave()
      const image = droppedAvatarSource(event.dataTransfer)
      if (image) {
        takeFromHost(image)
      }
    }
    host.addEventListener('paste', onPaste)
    host.addEventListener('dragenter', onDragEnter)
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('dragleave', onDragLeave)
    host.addEventListener('drop', onDrop)
    // A drag that ends elsewhere (Esc, or dropped outside) never sends dragleave here.
    document.addEventListener('dragend', leave, true)
    document.addEventListener('drop', leave, true)
    return () => {
      host.removeEventListener('paste', onPaste)
      host.removeEventListener('dragenter', onDragEnter)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('dragleave', onDragLeave)
      host.removeEventListener('drop', onDrop)
      document.removeEventListener('dragend', leave, true)
      document.removeEventListener('drop', leave, true)
      host.removeAttribute(BOT_PICTURE_DROP_ATTRIBUTE)
    }
  }, [rootRef])

  useEffect(
    () => () => {
      run.current += 1
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  return { line, outlinePicker, take, dismiss }
}
