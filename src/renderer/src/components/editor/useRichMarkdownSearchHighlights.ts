import { useEffect, useRef, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { richMarkdownSearchPluginKey, type RichMarkdownSearchMatch } from './rich-markdown-search'

type SearchNavigation = {
  editor: Editor
  query: string
  matchCase: boolean
  wholeWord: boolean
  navigationRequest: { revision: number; selectMatch: boolean }
}

export function useRichMarkdownSearchHighlights({
  activeMatchIndex,
  editor,
  matchCase,
  matches,
  navigationRequest,
  query,
  rootRef,
  searchDocument,
  scrollContainerRef,
  wholeWord
}: {
  activeMatchIndex: number
  editor: Editor | null
  matchCase: boolean
  matches: RichMarkdownSearchMatch[]
  navigationRequest: SearchNavigation['navigationRequest']
  query: string
  rootRef: RefObject<HTMLDivElement | null>
  searchDocument: ProseMirrorNode | null
  scrollContainerRef: RefObject<HTMLDivElement | null>
  wholeWord: boolean
}): void {
  const lastNavigationRef = useRef<SearchNavigation | null>(null)

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      lastNavigationRef.current = null
      return
    }
    // A newer editor transaction can arrive between render and this effect.
    if (editor.state.doc !== searchDocument) {
      return
    }
    const previous = lastNavigationRef.current
    const searchChanged =
      previous?.editor !== editor ||
      previous.query !== query ||
      previous.matchCase !== matchCase ||
      previous.wholeWord !== wholeWord
    const navigationRequested =
      previous?.editor === editor && previous.navigationRequest !== navigationRequest
    lastNavigationRef.current = { editor, query, matchCase, wholeWord, navigationRequest }

    // Refreshing matches after an edit must preserve the user's caret and viewport.
    const activeElement = rootRef.current?.ownerDocument.activeElement
    const searchOwnsFocus =
      activeElement &&
      rootRef.current?.contains(activeElement) &&
      activeElement.closest('.rich-markdown-search')
    const shouldNavigate = navigationRequested
      ? navigationRequest.selectMatch
      : searchChanged && searchOwnsFocus
    const activeMatch =
      shouldNavigate && query && activeMatchIndex >= 0 ? matches[activeMatchIndex] : null
    const tr = editor.state.tr.setMeta(richMarkdownSearchPluginKey, {
      activeIndex: activeMatchIndex,
      matches,
      query
    })
    if (activeMatch) {
      tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to))
    }
    editor.view.dispatch(tr)
    if (editor.isDestroyed || editor.state.doc !== tr.doc) {
      return
    }

    // The editor's scrollIntoView does not reliably reach the outer flex viewport.
    const container = scrollContainerRef.current
    if (activeMatch && container) {
      const coords = editor.view.coordsAtPos(activeMatch.from)
      const containerRect = container.getBoundingClientRect()
      const relativeTop = coords.top - containerRect.top
      const targetScroll = container.scrollTop + relativeTop - containerRect.height / 2
      container.scrollTo({ top: targetScroll, behavior: 'instant' })
    }
  }, [
    activeMatchIndex,
    editor,
    matchCase,
    matches,
    navigationRequest,
    query,
    rootRef,
    searchDocument,
    scrollContainerRef,
    wholeWord
  ])
}
