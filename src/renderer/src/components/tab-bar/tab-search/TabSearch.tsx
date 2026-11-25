import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList
} from '@/components/ui/command'
import { useModalReturnFocus } from '@/lib/pane-manager/pane-focus/useModalReturnFocus'
import { useTranslate } from '@/i18n/use-translate'
import { createPaletteSearchContext } from '../../../../../shared/palette-match/palette-ranking'
import type { OpenTabPaletteItem } from '@/components/worktree-jump/worktree-jump-palette-model'
import { FooterKey } from '@/components/worktree-jump/rows/worktree-jump-palette-row-content'
import { buildTabSearchIndex, type TabSearchIndex } from './tab-search-index'
import { searchTabSearchIndex } from './tab-search-results'
import { activateTabSearchItem, closeTabSearchItem } from './tab-search-actions'
import { TabSearchRow } from './TabSearchRow'

const TAB_SEARCH_CLOSE_LINGER_MS = 300

export default function TabSearch(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'tab-search')
  const [lingering, setLingering] = useState(visible)
  useEffect(() => {
    if (visible) {
      setLingering(true)
      return
    }
    // Keep the dialog mounted through its exit animation.
    const timer = window.setTimeout(() => setLingering(false), TAB_SEARCH_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!visible && !lingering) {
    return null
  }
  return <TabSearchContent visible={visible} />
}

type TabSearchSession = {
  index: TabSearchIndex
  context: ReturnType<typeof createPaletteSearchContext>
}

function openSession(): TabSearchSession {
  return {
    index: buildTabSearchIndex(useAppStore.getState()),
    context: createPaletteSearchContext(Date.now())
  }
}

function TabSearchContent({ visible }: { visible: boolean }): React.JSX.Element {
  const t = useTranslate()
  const closeModal = useAppStore((s) => s.closeModal)
  const [session, setSession] = useState(openSession)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const deferredQuery = useDeferredValue(query)
  const { captureReturnFocus, skipReturnFocus } = useModalReturnFocus(visible)

  // A reopen inside the exit animation starts a fresh snapshot and query.
  const [previousVisible, setPreviousVisible] = useState(visible)
  if (visible !== previousVisible) {
    setPreviousVisible(visible)
    if (visible) {
      setSession(openSession())
      setQuery('')
      setSelectedId('')
    }
  }

  const items = useMemo(
    () => searchTabSearchIndex(session.index, deferredQuery, session.context, t),
    [session, deferredQuery, t]
  )
  const effectiveSelectedId = items.some((item) => item.id === selectedId)
    ? selectedId
    : (items[0]?.id ?? '')

  // Prompted closes (pinned, unsaved, running process) land later; refresh once tabs change.
  const pendingCloseRefreshRef = useRef(false)
  useEffect(() => {
    if (!visible) {
      return
    }
    return useAppStore.subscribe((state, previous) => {
      if (
        pendingCloseRefreshRef.current &&
        (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
          state.browserPagesByWorkspace !== previous.browserPagesByWorkspace)
      ) {
        pendingCloseRefreshRef.current = false
        setSession((current) => ({ ...current, index: buildTabSearchIndex(state) }))
      }
    })
  }, [visible])

  const handleSelect = useCallback(
    (item: OpenTabPaletteItem) => {
      if (!activateTabSearchItem(item)) {
        return
      }
      // Activation focuses the chosen tab; returning focus would undo it.
      skipReturnFocus()
      closeModal()
    },
    [closeModal, skipReturnFocus]
  )

  const handleClose = useCallback(
    (item: OpenTabPaletteItem) => {
      const position = items.findIndex((candidate) => candidate.id === item.id)
      if (item.id === effectiveSelectedId) {
        // Like Chrome, the selection moves to the row that takes the closed row's place.
        setSelectedId(items[position + 1]?.id ?? items[position - 1]?.id ?? '')
      }
      pendingCloseRefreshRef.current = true
      closeTabSearchItem(item)
    },
    [effectiveSelectedId, items]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const preventRadixReturnFocus = useCallback((event: Event) => {
    // useModalReturnFocus restores the opening surface instead of Radix's trigger.
    event.preventDefault()
  }, [])

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      commandProps={{ value: effectiveSelectedId, onValueChange: setSelectedId, loop: true }}
      onOpenAutoFocus={captureReturnFocus}
      onCloseAutoFocus={preventRadixReturnFocus}
      title={t('auto.components.tab.bar.tab.search.TabSearch.789246b689', 'Search tabs')}
      description={t(
        'auto.components.tab.bar.tab.search.TabSearch.7f56c1fde9',
        'Search open tabs in every workspace'
      )}
    >
      <CommandInput
        placeholder={t('auto.components.tab.bar.tab.search.TabSearch.789246b689', 'Search tabs')}
        value={query}
        onValueChange={(value) => {
          setQuery(value)
          setSelectedId('')
        }}
      />
      <CommandList className="max-h-[min(28rem,60vh)]">
        {items.length === 0 ? (
          <CommandEmpty>
            {deferredQuery.trim()
              ? t('auto.components.tab.bar.tab.search.TabSearch.bc2174bc27', 'No matching tabs')
              : t('auto.components.tab.bar.tab.search.TabSearch.3b27fc7f7c', 'No open tabs')}
          </CommandEmpty>
        ) : (
          <CommandGroup
            heading={t('auto.components.tab.bar.tab.search.TabSearch.e6d5cf7750', 'Open tabs')}
          >
            {items.map((item) => (
              <TabSearchRow
                key={item.id}
                item={item}
                onSelect={handleSelect}
                onClose={handleClose}
              />
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <FooterKey>{t('auto.components.QuickOpen.250e5b2dfb', 'Enter')}</FooterKey>
        <span>{t('auto.components.tab.bar.tab.search.TabSearch.e555a5a097', 'Switch')}</span>
        <FooterKey>{t('auto.components.QuickOpen.95fccbae88', 'Esc')}</FooterKey>
        <span>{t('auto.components.QuickOpen.73b2c581f1', 'Close')}</span>
        <FooterKey>↑↓</FooterKey>
        <span>{t('auto.components.QuickOpen.1dbd3f59ff', 'Move')}</span>
      </div>
      <div aria-live="polite" className="sr-only">
        {deferredQuery.trim()
          ? t('auto.components.tab.bar.tab.search.TabSearch.tabsFound', '{{count}} tabs found', {
              count: items.length,
              defaultValue_one: '{{count}} tab found'
            })
          : ''}
      </div>
    </CommandDialog>
  )
}
