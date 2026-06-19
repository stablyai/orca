import { useCallback, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { MarkdownDocument } from '../../../../shared/types'
import { getMarkdownDocCompletionDocuments } from './markdown-doc-completions'
import type { DocLinkMenuRow, DocLinkMenuState } from './rich-markdown-commands'
import {
  slashCommands,
  type SlashCommand,
  type SlashMenuState
} from './rich-markdown-slash-commands'

const DOC_LINK_MENU_MAX_ROWS = 20

type MenuSelection = {
  index: number
  query: string | null
}

export function useRichMarkdownMenuController({
  markdownDocuments
}: {
  markdownDocuments?: MarkdownDocument[]
}) {
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [slashSelection, setSlashSelection] = useState<MenuSelection>({ query: null, index: 0 })
  const [docLinkMenu, setDocLinkMenu] = useState<DocLinkMenuState | null>(null)
  const [docLinkSelection, setDocLinkSelection] = useState<MenuSelection>({ query: null, index: 0 })
  const [emojiMenu, setEmojiMenu] = useState<{ left: number; top: number } | null>(null)
  const slashMenuRef = useRef<SlashMenuState | null>(null)
  const filteredSlashCommandsRef = useRef<SlashCommand[]>(slashCommands)
  const selectedCommandIndexRef = useRef(0)
  const docLinkMenuRef = useRef<DocLinkMenuState | null>(null)
  const filteredDocLinkRowsRef = useRef<DocLinkMenuRow[]>([])
  const selectedDocLinkIndexRef = useRef(0)
  const handleEmojiPickRef = useRef<(menu: SlashMenuState) => void>(() => {})

  slashMenuRef.current = slashMenu
  docLinkMenuRef.current = docLinkMenu

  const setSelectedCommandIndex = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (nextIndex) => {
      setSlashSelection((current) => {
        const query = slashMenuRef.current?.query ?? null
        const optionCount = filteredSlashCommandsRef.current.length
        const currentIndex =
          current.query === query ? clampMenuSelectionIndex(current.index, optionCount) : 0
        const resolvedIndex = typeof nextIndex === 'function' ? nextIndex(currentIndex) : nextIndex
        return {
          query,
          index: clampMenuSelectionIndex(resolvedIndex, optionCount)
        }
      })
    },
    []
  )

  const setSelectedDocLinkIndex = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (nextIndex) => {
      setDocLinkSelection((current) => {
        const query = docLinkMenuRef.current?.query ?? null
        const rowCount = filteredDocLinkRowsRef.current.length
        const currentIndex =
          current.query === query ? clampMenuSelectionIndex(current.index, rowCount) : 0
        const resolvedIndex = typeof nextIndex === 'function' ? nextIndex(currentIndex) : nextIndex
        return {
          query,
          index: clampMenuSelectionIndex(resolvedIndex, rowCount)
        }
      })
    },
    []
  )

  const filteredSlashCommands = useMemo(() => {
    const query = slashMenu?.query.trim().toLowerCase() ?? ''
    if (!query) {
      return slashCommands
    }
    return slashCommands.filter((command) => {
      const haystack = [command.label, ...command.aliases].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [slashMenu?.query])
  const selectedCommandIndex = resolveSelectedMenuIndex(
    slashSelection,
    slashMenu?.query ?? null,
    filteredSlashCommands.length
  )
  filteredSlashCommandsRef.current = filteredSlashCommands
  selectedCommandIndexRef.current = selectedCommandIndex

  const { docLinkRows, docLinkTotalMatches } = useMemo(() => {
    if (!docLinkMenu || !markdownDocuments) {
      return { docLinkRows: [] as DocLinkMenuRow[], docLinkTotalMatches: 0 }
    }
    const matches = getMarkdownDocCompletionDocuments(markdownDocuments, docLinkMenu.query)
    const rows: DocLinkMenuRow[] = matches
      .slice(0, DOC_LINK_MENU_MAX_ROWS)
      .map((document) => ({ kind: 'document', document }))
    return { docLinkRows: rows, docLinkTotalMatches: matches.length }
  }, [docLinkMenu, markdownDocuments])
  const selectedDocLinkIndex = resolveSelectedMenuIndex(
    docLinkSelection,
    docLinkMenu?.query ?? null,
    docLinkRows.length
  )
  filteredDocLinkRowsRef.current = docLinkRows
  selectedDocLinkIndexRef.current = selectedDocLinkIndex

  const openEmojiMenu = useCallback((menu: SlashMenuState): void => {
    setSlashMenu(null)
    setEmojiMenu({ left: menu.left, top: menu.top })
  }, [])
  handleEmojiPickRef.current = openEmojiMenu

  return {
    docLinkMenu,
    docLinkRows,
    docLinkTotalMatches,
    docLinkMenuRef,
    emojiMenu,
    filteredDocLinkRowsRef,
    filteredSlashCommands,
    filteredSlashCommandsRef,
    handleEmojiPickRef,
    openEmojiMenu,
    selectedCommandIndex,
    selectedCommandIndexRef,
    selectedDocLinkIndex,
    selectedDocLinkIndexRef,
    setDocLinkMenu,
    setEmojiMenu,
    setSelectedCommandIndex,
    setSelectedDocLinkIndex,
    setSlashMenu,
    slashMenu,
    slashMenuRef
  }
}

function resolveSelectedMenuIndex(
  selection: MenuSelection,
  query: string | null,
  itemCount: number
): number {
  return selection.query === query ? clampMenuSelectionIndex(selection.index, itemCount) : 0
}

function clampMenuSelectionIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0
  }
  return Math.min(Math.max(index, 0), itemCount - 1)
}
