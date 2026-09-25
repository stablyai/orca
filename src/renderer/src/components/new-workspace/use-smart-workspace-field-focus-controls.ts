import { useCallback } from 'react'
import type { NormalizedSmartWorkspaceNameFieldProps } from './smart-workspace-name-field-model'
import type { useSmartWorkspaceNameFieldState } from './use-smart-workspace-name-field-state'

type FieldState = ReturnType<typeof useSmartWorkspaceNameFieldState>

export function useSmartWorkspaceFieldFocusControls({
  props,
  state
}: {
  props: NormalizedSmartWorkspaceNameFieldProps
  state: FieldState
}) {
  const { disabled, selectedSource, inputRef } = props
  const {
    mode,
    setOpen,
    focusedSelectedSourceKeyRef,
    localInputFocusFrameRef,
    deferSourcePopoverUntilInteractionRef,
    localInputRef
  } = state
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
    setSelectedSourceNode,
    cancelLocalInputFocusFrame,
    markSourcePopoverUserEngaged,
    tryOpenSourcePopover,
    handleSourcePopoverOpenChange,
    setInputNode
  }
}
