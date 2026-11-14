import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'

function hasTranscriptSelection(root: HTMLElement | null): boolean {
  const selection = root?.ownerDocument.getSelection()
  if (!root || !selection || selection.isCollapsed) {
    return false
  }
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(root)) {
      return true
    }
  }
  return false
}

/** A folded row can own thousands of raw items while its selected text is still mounted. */
export function useNativeChatSelectedHistory({
  root,
  retainHistory,
  trimHistory,
  sourceKey,
  isVisible
}: {
  root: React.RefObject<HTMLElement | null>
  sourceKey: string
  isVisible: boolean
} & Pick<NativeChatLiveSession, 'retainHistory' | 'trimHistory'>) {
  const release = useRef<(() => void) | null>(null)
  const owesTrim = useRef(false)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const protectSelection = useCallback(() => {
    if (!hasTranscriptSelection(root.current)) {
      return false
    }
    setSelectedSource(sourceKey)
    if (release.current == null) {
      release.current = retainHistory?.() ?? null
    }
    return true
  }, [root, retainHistory, sourceKey])
  const deferTrim = useCallback(() => {
    owesTrim.current = true
  }, [])
  const cancelTrim = useCallback(() => {
    owesTrim.current = false
  }, [])
  const selectionChanged = useEffectEvent(() => {
    if (protectSelection()) {
      return
    }
    setSelectedSource(null)
    release.current?.()
    release.current = null
    if (owesTrim.current) {
      owesTrim.current = false
      trimHistory?.()
    }
  })
  useEffect(() => {
    if (!isVisible && selectedSource !== sourceKey) {
      return
    }
    const document = root.current?.ownerDocument
    document?.addEventListener('selectionchange', selectionChanged)
    selectionChanged()
    return () => document?.removeEventListener('selectionchange', selectionChanged)
  }, [root, sourceKey, isVisible, selectedSource])
  useEffect(
    () => () => {
      release.current?.()
      release.current = null
      owesTrim.current = false
    },
    [retainHistory, sourceKey]
  )
  return { protectSelection, deferTrim, cancelTrim }
}
