import { Check, ChevronDown } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { COMPOSER_FIELD_CLASS } from './create-hosted-review-composer-field-class'
import { CreateHostedReviewComposerMessage } from './CreateHostedReviewComposerMessage'
import { stripBaseRef } from './create-pull-request-base-ref-normalization'

type CreateHostedReviewBasePickerProps = {
  copy: LocalizedHostedReviewCopy
  base: string
  setBase: (value: string) => void
  /** The repo's default branch, where an emptied field lands. Null until resolved. */
  repoDefaultBase: string | null
  editing: boolean
  setEditing: (value: boolean) => void
  baseQuery: string
  setBaseQuery: (value: string) => void
  baseResults: string[]
  setBaseResults: (value: string[]) => void
  baseSearchPending: boolean
  baseSearchError: string | null
  fieldsLocked: boolean
  strippedBranch: string
  baseSameAsBranch: boolean
}

/** Keep merge-target results and base-scoped errors attached to the full-width field. */
export function CreateHostedReviewBasePicker({
  copy,
  base,
  setBase,
  repoDefaultBase,
  editing,
  setEditing,
  baseQuery,
  setBaseQuery,
  baseResults,
  setBaseResults,
  baseSearchPending,
  baseSearchError,
  fieldsLocked,
  strippedBranch,
  baseSameAsBranch
}: CreateHostedReviewBasePickerProps): React.JSX.Element {
  const [activeResult, setActiveResult] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  // Why: marks a blur that an explicit Enter/Escape already resolved.
  const settledRef = useRef(false)
  const fieldId = useId()
  const resultsId = useId()

  const trimmedQuery = baseQuery.trim()
  const trimmedRepoDefault = repoDefaultBase?.trim() ?? ''
  const showResults = editing && baseResults.length > 0
  // Name the default an emptied field will choose so resetting cannot be invisible.
  const showRepoDefaultHint = editing && trimmedQuery.length === 0 && trimmedRepoDefault.length > 0
  // Wait for settled search evidence before claiming no matches; debounce alone proves no absence.
  const showNoResults =
    editing &&
    baseResults.length === 0 &&
    trimmedQuery.length >= 2 &&
    !baseSearchPending &&
    !baseSearchError

  const closeSearch = (): void => {
    setEditing(false)
    setBaseQuery('')
    setBaseResults([])
    setActiveResult(-1)
  }

  const commitSearch = (value: string): void => {
    // Empty commits choose the repo default; before it resolves, preserve the committed base instead of guessing.
    const nextBase = value.trim() || trimmedRepoDefault
    if (nextBase) {
      setBase(nextBase)
    }
    settledRef.current = true
    closeSearch()
    inputRef.current?.blur()
  }

  const cancelSearch = (): void => {
    settledRef.current = true
    closeSearch()
    inputRef.current?.blur()
  }

  const handleBlur = (): void => {
    // Enter/Escape already resolved their own blur; do not recommit the pre-close query.
    if (settledRef.current) {
      settledRef.current = false
      closeSearch()
      return
    }
    // Blur of an empty query also chooses the default; partial queries still cancel.
    if (trimmedQuery.length === 0 && trimmedRepoDefault) {
      setBase(trimmedRepoDefault)
    }
    closeSearch()
  }

  const moveActiveResult = (delta: number): void => {
    if (baseResults.length === 0) {
      return
    }
    setActiveResult((current) => {
      const next = current + delta
      if (next < 0) {
        return baseResults.length - 1
      }
      return next >= baseResults.length ? 0 : next
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActiveResult(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitSearch(baseResults[activeResult] ?? baseQuery)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelSearch()
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        {/* Keep the label on one line and let long head refs absorb narrowing. */}
        <Label
          htmlFor={fieldId}
          className="shrink-0 whitespace-nowrap text-[11px] font-medium text-muted-foreground"
        >
          {translate(
            'auto.components.right.sidebar.CreateHostedReviewBasePicker.205ef284fa',
            'Base branch'
          )}
        </Label>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={strippedBranch}>
          {translate(
            'auto.components.right.sidebar.CreateHostedReviewBasePicker.bb4b41d563',
            'from {{value0}}',
            { value0: strippedBranch }
          )}
        </span>
      </div>

      <div className="relative">
        <Input
          id={fieldId}
          ref={inputRef}
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.6055949c50',
            '{{value0}} base branch',
            { value0: copy.titleLabel }
          )}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showResults}
          // Reference the results list only while its ID exists.
          aria-controls={showResults ? resultsId : undefined}
          aria-activedescendant={
            showResults && activeResult >= 0 ? `${resultsId}-${activeResult}` : undefined
          }
          aria-invalid={baseSameAsBranch || undefined}
          title={editing ? undefined : base}
          value={editing ? baseQuery : base}
          disabled={fieldsLocked}
          onFocus={(event) => {
            // Clear a stale programmatic-blur latch before the next real focus/blur cycle.
            settledRef.current = false
            setEditing(true)
            setBaseQuery(event.currentTarget.value)
          }}
          onBlur={handleBlur}
          onChange={(event) => {
            setBaseQuery(event.target.value)
            setActiveResult(-1)
          }}
          onKeyDown={handleKeyDown}
          // Name the actual default, which may be trunk rather than main.
          placeholder={
            trimmedRepoDefault ||
            translate('auto.components.right.sidebar.SourceControl.e64a632456', 'main')
          }
          className={cn(COMPOSER_FIELD_CLASS, 'pl-2 pr-7')}
        />
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
      </div>

      {showResults ? (
        <div
          id={resultsId}
          role="listbox"
          className="max-h-40 overflow-auto rounded-md border border-input bg-popover p-1 shadow-xs scrollbar-sleek"
        >
          {baseResults.map((ref, index) => {
            const selected = stripBaseRef(base) === ref
            return (
              <button
                key={ref}
                id={`${resultsId}-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={index === activeResult ? 'true' : undefined}
                disabled={fieldsLocked}
                className={cn(
                  'flex h-7 w-full items-center justify-between gap-2 rounded-sm px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  selected && 'text-foreground'
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                  commitSearch(ref)
                }}
              >
                <span className="truncate">{ref}</span>
                {selected ? <Check className="size-3 shrink-0" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      {showRepoDefaultHint ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.CreateHostedReviewBasePicker.da4d57c9c2',
            'Leave empty to use {{value0}}.',
            { value0: trimmedRepoDefault }
          )}
        </p>
      ) : null}

      {showNoResults ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.CreateHostedReviewBasePicker.5a9315b61a',
            'No branches match “{{value0}}”. Press Enter to use it anyway.',
            { value0: trimmedQuery }
          )}
        </p>
      ) : null}

      {baseSameAsBranch ? (
        <CreateHostedReviewComposerMessage>
          {translate(
            'auto.components.right.sidebar.SourceControl.ae743199cd',
            'Choose a different base branch before creating a {{value0}}.',
            { value0: copy.reviewLabel }
          )}
        </CreateHostedReviewComposerMessage>
      ) : null}
      {baseSearchError ? (
        <CreateHostedReviewComposerMessage>{baseSearchError}</CreateHostedReviewComposerMessage>
      ) : null}
    </div>
  )
}
