import { useCallback, useEffect, useRef, useState } from 'react'
import type { SmartWorkspaceNameFieldProps } from './smart-workspace-name-field-model'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

type FieldState = { mode: SmartNameMode; crossRepoPrompt?: unknown }

export function useSmartWorkspaceFieldFocusControls({
  props,
  state
}: {
  props: Pick<SmartWorkspaceNameFieldProps, 'selectedSource' | 'inputRef'> & { disabled: boolean }
  state: FieldState
}) {
  const { disabled, selectedSource, inputRef } = props
  const { mode, crossRepoPrompt } = state
  const [open, setOpen] = useState(false)
  const [emojiCommandValue, setEmojiCommandValue] = useState('')
  const [emojiCursor, setEmojiCursor] = useState<number | null>(null)
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const focusedSelectedSourceKeyRef = useRef<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement | null>(null)
  const localInputFocusFrameRef = useRef<number | null>(null)
  const deferSourcePopoverUntilInteractionRef = useRef(true)
  useEffect(() => {
    if (disabled || mode === 'text' || crossRepoPrompt) {
      setOpen(false)
    }
  }, [disabled, mode, crossRepoPrompt])
  const selectedSourceFocusKey = selectedSource
    ? `${selectedSource.kind}:${selectedSource.label}:${selectedSource.url ?? ''}`
    : null
  const setSelectedSourceNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        focusedSelectedSourceKeyRef.current = null
        return
      }
      if (
        !selectedSourceFocusKey ||
        focusedSelectedSourceKeyRef.current === selectedSourceFocusKey
      ) {
        return
      }
      focusedSelectedSourceKeyRef.current = selectedSourceFocusKey
      // Why: input unmounts after row acceptance; focus the pill so the next Enter advances.
      node.focus({ preventScroll: true })
    },
    [focusedSelectedSourceKeyRef, selectedSourceFocusKey]
  )
  const cancelLocalInputFocusFrame = useCallback((): void => {
    if (localInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(localInputFocusFrameRef.current)
    localInputFocusFrameRef.current = null
  }, [localInputFocusFrameRef])
  const markSourcePopoverUserEngaged = useCallback((): void => {
    deferSourcePopoverUntilInteractionRef.current = false
  }, [deferSourcePopoverUntilInteractionRef])
  const tryOpenSourcePopover = useCallback((): void => {
    if (disabled || mode === 'text' || deferSourcePopoverUntilInteractionRef.current) {
      return
    }
    setOpen(true)
  }, [deferSourcePopoverUntilInteractionRef, disabled, mode, setOpen])
  const handleSourcePopoverOpenChange = useCallback(
    (next: boolean): void => {
      if (disabled || selectedSource) {
        setOpen(false)
        return
      }
      if (next && deferSourcePopoverUntilInteractionRef.current) {
        return
      }
      setOpen(next)
    },
    [deferSourcePopoverUntilInteractionRef, disabled, selectedSource, setOpen]
  )
  const setInputNode = useCallback(
    (node: HTMLInputElement | null) => {
      if (node === null) {
        cancelLocalInputFocusFrame()
      }
      localInputRef.current = node
      if (inputRef) {
        inputRef.current = node
      }
    },
    [cancelLocalInputFocusFrame, inputRef, localInputRef]
  )

  return {
    open,
    setOpen,
    emojiCommandValue,
    setEmojiCommandValue,
    emojiCursor,
    setEmojiCursor,
    localInputRef,
    tabsListRef,
    localInputFocusFrameRef,
    setSelectedSourceNode,
    cancelLocalInputFocusFrame,
    markSourcePopoverUserEngaged,
    tryOpenSourcePopover,
    handleSourcePopoverOpenChange,
    setInputNode
  }
}
