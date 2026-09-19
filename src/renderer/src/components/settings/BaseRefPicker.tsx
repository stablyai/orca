/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: base-ref defaults and search results come from runtime repo IPC and must clear stale repo results before new requests resolve. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAppStore } from '@/store'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import { cn } from '@/lib/utils'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type BaseRefPickerProps = {
  repoId: string
  hostId?: ExecutionHostId
  currentBaseRef?: string
  onSelect: (ref: string) => void
  onUsePrimary?: () => void
}

export function BaseRefPicker({
  repoId,
  hostId,
  currentBaseRef,
  onSelect,
  onUsePrimary
}: BaseRefPickerProps): React.JSX.Element {
  const focusedRuntimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForRepo(state, repoId)
  )
  const selectedHost = parseExecutionHostId(hostId)
  const activeRuntimeEnvironmentId = hostId
    ? selectedHost?.kind === 'runtime'
      ? selectedHost.environmentId
      : null
    : focusedRuntimeEnvironmentId
  // Why: null until the IPC resolves (or when the repo has no default base ref
  // available). We avoid seeding with 'origin/main' because that would display
  // a fabricated default in repos that don't actually have origin/main.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  // Why: starts at 0 so the multi-remote hint stays suppressed until the IPC
  // resolves. `0` is also the failure sentinel: if the main-process remote
  // count throws, we prefer no hint over a wrong hint (fail-closed per
  // docs/upstream-base-ref-design.md §4).
  const [remoteCount, setRemoteCount] = useState<number>(0)
  const [baseRefQuery, setBaseRefQuery] = useState('')
  const [baseRefResults, setBaseRefResults] = useState<string[]>([])
  const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const baseRefResultsListRef = useRef<HTMLDivElement>(null)
  const resultsId = useId()

  // Why: a highlight is only meaningful for the list it was moved through.
  useEffect(() => {
    setActiveIndex(-1)
  }, [baseRefResults])

  // Why: Radix Dialog scroll-lock cancels wheel events on in-dialog scroll
  // regions, so we scroll the results list manually (same pattern as CommandList).
  useEffect(() => {
    const el = baseRefResultsListRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight) {
        return
      }
      event.preventDefault()
      el.scrollTop += event.deltaY
      // Why: rows scrolling under a resting mouse fire no pointermove, so re-pick the row as native hover did.
      const option = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[role="option"]')
      const index = Number(option?.dataset.index)
      setActiveIndex(Number.isInteger(index) ? index : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [baseRefResults.length])

  useEffect(() => {
    let stale = false

    const loadDefaultBaseRef = async (): Promise<void> => {
      try {
        const result = await getRuntimeRepoBaseRefDefault(
          { activeRuntimeEnvironmentId },
          repoId,
          hostId
        )
        if (!stale) {
          setDefaultBaseRef(result.defaultBaseRef)
          setRemoteCount(result.remoteCount)
        }
      } catch (err) {
        console.error('[BaseRefPicker] getBaseRefDefault failed', err)
        if (!stale) {
          setDefaultBaseRef(null)
          setRemoteCount(0)
        }
      }
    }

    setBaseRefQuery('')
    setBaseRefResults([])
    // Why: reset the previous repo's default ref before the new IPC resolves so
    // we never attribute a stale "Following primary branch (<ref>)" label to
    // the newly selected repo during the brief resolution window.
    setDefaultBaseRef(null)
    setRemoteCount(0)
    void loadDefaultBaseRef()

    return () => {
      stale = true
    }
  }, [activeRuntimeEnvironmentId, hostId, repoId])

  useEffect(() => {
    if (!isRuntimeRepoRefSearchQueryWithinLimit(baseRefQuery)) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }
    const trimmedQuery = baseRefQuery.trim()
    if (trimmedQuery.length < 2) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }

    let stale = false
    setIsSearchingBaseRefs(true)

    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(
        { activeRuntimeEnvironmentId },
        repoId,
        trimmedQuery,
        20,
        hostId
      )
        .then((results) => {
          if (!stale) {
            setBaseRefResults(results)
          }
        })
        .catch((err) => {
          console.error('[BaseRefPicker] searchBaseRefs failed', err)
          if (!stale) {
            setBaseRefResults([])
          }
        })
        .finally(() => {
          if (!stale) {
            setIsSearchingBaseRefs(false)
          }
        })
    }, 200)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [activeRuntimeEnvironmentId, baseRefQuery, hostId, repoId])

  const effectiveBaseRef = currentBaseRef ?? defaultBaseRef
  const showResults = !isSearchingBaseRefs && baseRefResults.length > 0

  const selectBaseRef = (ref: string): void => {
    // Why: clear the query so the picker returns to its resting state after a
    // selection. Leaving the query populated would keep the results list
    // rendered and visually compete with the new "Pinned for this repo" label,
    // implying the selection is still pending.
    setBaseRefQuery('')
    setBaseRefResults([])
    onSelect(ref)
  }

  const moveActiveIndex = (delta: number): void => {
    if (!showResults) {
      return
    }
    const last = baseRefResults.length - 1
    const moved = activeIndex + delta
    const next = moved < 0 ? last : moved > last ? 0 : moved
    setActiveIndex(next)
    document.getElementById(`${resultsId}-${next}`)?.scrollIntoView({ block: 'nearest' })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Why: while composing, arrows and Enter belong to the IME (candidate navigation, confirm).
    if (isImeCompositionKeyDown(event)) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActiveIndex(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    // Why: mid-search the visible list is stale, so Enter must not pick from it.
    if (event.key === 'Enter' && showResults) {
      const activeRef = baseRefResults[activeIndex]
      if (activeRef === undefined) {
        return
      }
      event.preventDefault()
      selectBaseRef(activeRef)
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">
            {effectiveBaseRef ??
              translate('auto.components.settings.BaseRefPicker.ee110e1830', 'No default base ref')}
          </div>
          <p className="text-xs text-muted-foreground">
            {currentBaseRef
              ? translate(
                  'auto.components.settings.BaseRefPicker.2f3cda96f5',
                  'Pinned for this repo'
                )
              : defaultBaseRef
                ? translate(
                    'auto.components.settings.BaseRefPicker.086ce7f369',
                    'Following primary branch ({{value0}})',
                    { value0: defaultBaseRef }
                  )
                : translate(
                    'auto.components.settings.BaseRefPicker.9a14ec7400',
                    'Pick a base branch below'
                  )}
          </p>
          {/* Why: passive hint that fork workflows have other remotes worth
              searching (e.g. `upstream`). Host-agnostic and remote-name-agnostic
              by design — we don't hardcode `upstream` because a repo's source
              remote could be named anything (`source`, `canonical`, etc.).
              Suppressed when remoteCount <= 1 or when the IPC failed
              (remoteCount === 0), preserving today's no-hint behavior.
              See docs/upstream-base-ref-design.md §4. */}
          {remoteCount > 1 ? (
            // Why: no aria-live — this is static instructional copy that renders
            // whenever remoteCount>1, not a dynamic status update. aria-live would
            // cause screen readers to re-announce it on every mount/repo switch.
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BaseRefPicker.a5c16712c1',
                'Multiple remotes detected. Type a remote name (e.g.'
              )}{' '}
              <code>
                {translate('auto.components.settings.BaseRefPicker.915ad97875', 'upstream')}
              </code>
              {translate(
                'auto.components.settings.BaseRefPicker.80f7c82303',
                ') or a full ref (e.g.'
              )}{' '}
              <code>
                {translate('auto.components.settings.BaseRefPicker.b468f46726', 'upstream/main')}
              </code>
              {translate(
                'auto.components.settings.BaseRefPicker.ade9a5bb03',
                ') to scope results.'
              )}
            </p>
          ) : null}
        </div>
        {onUsePrimary && (
          <Button variant="outline" size="sm" onClick={onUsePrimary} disabled={!currentBaseRef}>
            {translate('auto.components.settings.BaseRefPicker.773a5687a3', 'Use Primary')}
          </Button>
        )}
      </div>

      <Input
        value={baseRefQuery}
        onChange={(e) => setBaseRefQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-label={translate(
          'auto.components.right.sidebar.CreateHostedReviewBasePicker.205ef284fa',
          'Base branch'
        )}
        aria-autocomplete="list"
        aria-expanded={showResults}
        aria-controls={showResults ? resultsId : undefined}
        aria-activedescendant={
          showResults && activeIndex >= 0 ? `${resultsId}-${activeIndex}` : undefined
        }
        placeholder={translate(
          'auto.components.settings.BaseRefPicker.7db7fb87e5',
          'Search branches by name...'
        )}
        className="max-w-md"
      />

      {isSearchingBaseRefs ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.settings.BaseRefPicker.a4a9372eb2', 'Searching branches...')}
        </p>
      ) : null}

      {!isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (
        baseRefResults.length > 0 ? (
          <div
            ref={baseRefResultsListRef}
            onPointerLeave={() => setActiveIndex(-1)}
            className="max-h-[min(12rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md border border-border/50 scrollbar-sleek"
          >
            <div id={resultsId} role="listbox" className="p-1">
              {baseRefResults.map((ref, index) => (
                <button
                  key={ref}
                  id={`${resultsId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={effectiveBaseRef === ref}
                  data-index={index}
                  data-selected={index === activeIndex ? 'true' : undefined}
                  // Why move, not enter: keyboard scrolling slides rows under a resting mouse, which must not steal the highlight.
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => selectBaseRef(ref)}
                  // Why no `hover:`: mouse and keyboard share one highlight, so only one row is ever lit.
                  // Why foreground/8 in light: the old muted/60 hover is invisible on white without a pointer to mark it.
                  className={cn(
                    'flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors data-[selected=true]:bg-foreground/8 dark:data-[selected=true]:bg-muted/60',
                    effectiveBaseRef === ref
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground'
                  )}
                >
                  <span className="truncate">{ref}</span>
                  {effectiveBaseRef === ref ? (
                    <span className="text-[10px] uppercase tracking-[0.18em]">
                      {translate('auto.components.settings.BaseRefPicker.d166ff883d', 'Current')}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BaseRefPicker.1b8e54151f',
              'No matching branches found.'
            )}
          </p>
        )
      ) : null}
    </div>
  )
}
