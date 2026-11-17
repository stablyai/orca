import { getShadowRootSelection } from '@/lib/shadow-root-selection'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { resolveFindAgainShortcut, type Editor } from '@pierre/diffs/edit'
import type { FileDiffMetadata } from '@pierre/diffs'
import { useTranslate } from '@/i18n/use-translate'
import { translateDiffSearchError } from './pierre-diff-search-status'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { editorShortcutMatches } from '@/components/editor/commands/editor-shortcuts'
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
  const t = useTranslate()
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
  const queryKey = useMemo(() => ({ query, side, open }), [query, side, open])
  const [selection, setSelection] = useState<{ queryKey: object; index: number }>()
  const selectedIntent = useRef<object | null>(null)
  const enabled = open && query.text.length > 0
  const [source, setSource] = useState<{
    fileDiff: FileDiffMetadata
    side: DiffSearchSide
    revision: number
    text: string
  } | null>(null)
  useLayoutEffect(() => {
    setSource(
      enabled
        ? {
            fileDiff,
            side,
            revision,
            text:
              side === 'deletions'
                ? fileDiff.deletionLines.join('')
                : (editorRef.current?.getText() ?? fileDiff.additionLines.join(''))
          }
        : null
    )
  }, [enabled, side, fileDiff, revision, editorRef])
  const request = useMemo(
    () =>
      enabled &&
      source?.fileDiff === fileDiff &&
      source.side === side &&
      source.revision === revision
        ? { revision: source.revision, text: source.text, query, replacement }
        : null,
    [enabled, source, fileDiff, side, revision, query, replacement]
  )
  const result = usePierreDiffSearchResults(request)
  const matches = result?.matches
  const index = Math.min(
    selection?.queryKey === queryKey ? selection.index : 0,
    Math.max(0, (matches?.length ?? 1) - 1)
  )
  const intent = selection?.queryKey === queryKey ? selection : queryKey
  const active = matches?.[index]
  const { onPostRender, selectActive } = usePierreDiffSearchView({
    fileDiff,
    side,
    matches,
    active,
    reveal: intent
  })
  const canReplace = isEditable && side === 'additions'
  // The first result or edit after a user intent consumes it, so edits never select.
  useEffect(() => {
    if (!result || selectedIntent.current === intent) {
      return
    }
    selectedIntent.current = intent
    if (canReplace && active) {
      editorRef.current?.setSelections([{ ...active.range, direction: 'forward' }])
    }
  }, [result, canReplace, active, editorRef, intent])
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
      setSelection({ queryKey, index: (index + direction + matches.length) % matches.length })
    },
    [request, matches, index, queryKey]
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
      if (
        isImeCompositionKeyDown(event) ||
        event.nativeEvent
          ?.composedPath()
          .some(
            (node) => node instanceof Element && node.matches('textarea, [data-diff-comment-id]')
          )
      ) {
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
      const selection = getShadowRootSelection(root)
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
              ? t('editor.diff.search.searching', 'Searching…')
              : !matches?.length
                ? t('auto.components.editor.MarkdownPreview.c5dc92cfe3', 'No results')
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
      selectedIntent.current = intent
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
