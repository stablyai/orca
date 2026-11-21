import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { EditorWordCount } from './editor-word-count'

function createWordCountStore() {
  let snapshot: EditorWordCount | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: EditorWordCount | null) {
      if (snapshot?.count === next?.count && snapshot?.selected === next?.selected) {
        return
      }
      snapshot = next
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

const WordCountContext = createContext<{
  fileId: string
  store: ReturnType<typeof createWordCountStore>
} | null>(null)

export function EditorWordCountProvider({
  fileId,
  children
}: {
  fileId: string
  children: ReactNode
}) {
  const value = useMemo(() => ({ fileId, store: createWordCountStore() }), [fileId])
  return <WordCountContext.Provider value={value}>{children}</WordCountContext.Provider>
}

export function useEditorWordCountStore(fileId: string) {
  const context = useContext(WordCountContext)
  return context && context.fileId === fileId ? context.store : null
}

const emptySubscribe = () => () => {}
const emptySnapshot = () => null

export function EditorWordCountDisplay() {
  const context = useContext(WordCountContext)
  const snapshot = useSyncExternalStore(
    context?.store.subscribe ?? emptySubscribe,
    context?.store.getSnapshot ?? emptySnapshot
  )
  const t = useTranslate()
  if (!snapshot) {
    return null
  }
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {snapshot.selected
        ? snapshot.count === 1
          ? t('editor.wordCount.selectedOne', '{{value}} word selected', { value: snapshot.count })
          : t('editor.wordCount.selectedMany', '{{value}} words selected', {
              value: snapshot.count
            })
        : snapshot.count === 1
          ? t('editor.wordCount.documentOne', '{{value}} word', { value: snapshot.count })
          : t('editor.wordCount.documentMany', '{{value}} words', { value: snapshot.count })}
    </span>
  )
}
