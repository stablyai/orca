import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveFindAgainShortcut, type Editor } from '@pierre/diffs/edit'
import type { FileDiffMetadata } from '@pierre/diffs'
import { translate } from '@/i18n/i18n'
import { translateDiffSearchError } from './pierre-diff-search-status'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { editorShortcutMatches } from '../editor-shortcuts'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'
import type { DiffSearchQuery } from './pierre-diff-search'
import type { DiffSearchSide, PierreDiffSearchBarProps } from './PierreDiffSearchBar'
import { usePierreDiffSearchResults } from './use-pierre-diff-search-results'
import { usePierreDiffSearchView } from './use-pierre-diff-search-view'

type DiffEditor = Editor<'file-diff', PierreDiffAnnotationData, undefined>

export function usePierreDiffFind({
  isEditable,
  containerRef,
  editorRef,
  fileDiff
}: {
  isEditable: boolean
  containerRef: React.RefObject<HTMLElement | null>
  editorRef: React.RefObject<DiffEditor | null>
  fileDiff: FileDiffMetadata
}) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<DiffSearchSide>('additions')
  const sideRef = useRef<DiffSearchSide>('additions')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState<DiffSearchQuery>({
    text: '',
    regex: false,
    matchCase: false,
    wholeWord: false
  })
  const [replacement, setReplacement] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<{ request: object; index: number }>()
  const request = useMemo(
    () =>
      open
        ? {
            text:
              side === 'deletions'
                ? fileDiff.deletionLines.join('')
                : (editorRef.current?.getText() ?? fileDiff.additionLines.join('')),
            query,
            replacement,
            revision
          }
        : null,
    [open, side, fileDiff, query, replacement, revision, editorRef]
  )
  const result = usePierreDiffSearchResults(request)
  const matches = result?.matches
  const index = selection?.request === request ? selection.index : 0
  const active = matches?.[index]
  const { onPostRender, selectActive } = usePierreDiffSearchView({
    fileDiff,
    side,
    matches,
    active
  })
  const canReplace = isEditable && side === 'additions'
  useEffect(() => {
    if (canReplace && active) {
      editorRef.current?.setSelections([{ ...active.range, direction: 'forward' }])
    }
  }, [canReplace, active, editorRef])
  const close = useCallback(() => {
    setOpen(false)
    if (isEditable && side === 'additions') {
      editorRef.current?.focus({ preventScroll: true })
    } else {
      editorRef.current?.setDeletedTextSelectionActive(side === 'deletions')
      selectActive()
      containerRef.current?.focus({ preventScroll: true })
    }
  }, [isEditable, side, editorRef, containerRef, selectActive])
  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!request || !matches?.length) {
        return
      }
      setSelection({ request, index: (index + direction + matches.length) % matches.length })
    },
    [request, matches, index]
  )
  const replace = (all: boolean) => {
    const editor = editorRef.current
    // Async matching must never apply offsets from an older document or query.
    if (
      !canReplace ||
      !editor ||
      !request ||
      !result ||
      result.errorCode ||
      request.text !== editor.getText() ||
      (all && result.truncated)
    ) {
      return
    }
    const targets = all ? result.matches : active ? [active] : []
    if (!targets.length) {
      return
    }
    editor.applyEdits(targets.map(({ range, replacement: newText }) => ({ range, newText })))
    setRevision((value) => value + 1)
  }
  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (isImeCompositionKeyDown(event)) {
        return
      }
      if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      const again =
        event.key === 'F3'
          ? event.shiftKey
            ? 'previous'
            : 'next'
          : resolveFindAgainShortcut(event.nativeEvent, getShortcutPlatform() === 'darwin')
      if (open && again) {
        event.preventDefault()
        event.stopPropagation()
        navigate(again === 'previous' ? -1 : 1)
        return
      }
      const find = editorShortcutMatches('editor.find', event)
      const replace = editorShortcutMatches('editor.replace', event)
      if (!find && !replace) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) {
        return
      }
      const nextSide = replace && isEditable ? 'additions' : sideRef.current
      sideRef.current = nextSide
      setSide(nextSide)
      if (replace && isEditable && nextSide === 'additions') {
        setReplaceOpen(true)
      }
      setOpen(true)
      const root = containerRef.current?.querySelector('diffs-container')?.shadowRoot
      const selection = (
        root as ShadowRoot & { getSelection?: () => Selection | null }
      )?.getSelection?.()
      const selected = root?.contains(selection?.anchorNode ?? null) ? selection?.toString() : ''
      if (selected) {
        setQuery((value) => ({ ...value, text: selected }))
      }
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    },
    [containerRef, isEditable, open, close, navigate]
  )
  useEffect(() => {
    if (open) {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    }
  }, [open])

  const searchBar: PierreDiffSearchBarProps | null = open
    ? {
        inputRef,
        query,
        side,
        replacement,
        replaceOpen,
        canReplace,
        canNavigate: Boolean(matches?.length),
        canReplaceAll: Boolean(matches?.length) && !result?.truncated,
        status:
          (result?.errorCode ? translateDiffSearchError(result.errorCode) : null) ??
          (!query.text
            ? '0/0'
            : !result
              ? translate('editor.diff.search.searching', 'Searching…')
              : !matches?.length
                ? translate('auto.components.editor.MarkdownPreview.c5dc92cfe3', 'No results')
                : `${index + 1}/${matches.length}${result.truncated ? '+' : ''}`),
        onQuery: setQuery,
        onReplacement: setReplacement,
        onToggleReplace: () => setReplaceOpen((value) => !value),
        onSide: (value) => {
          sideRef.current = value
          setSide(value)
          inputRef.current?.focus({ preventScroll: true })
        },
        onNavigate: navigate,
        onReplace: replace,
        onClose: close
      }
    : null
  return {
    searchBar,
    handleContainerKeyDown,
    onPostRender,
    onEditChange: () => {
      if (open) {
        setRevision((value) => value + 1)
      }
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      const path = event.nativeEvent.composedPath()
      const original = path.some(
        (node) =>
          node instanceof Element &&
          (node.matches('[data-code][data-deletions]') ||
            node.matches('[data-line-type="change-deletion"]'))
      )
      if (path.some((node) => node instanceof Element && node.matches('[data-code]'))) {
        sideRef.current = original ? 'deletions' : 'additions'
      }
    }
  }
}
