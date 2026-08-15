import { Check, ChevronDown } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { COMPOSER_FIELD_CLASS } from './create-hosted-review-composer-field-class'
import { CreateHostedReviewComposerMessage } from './CreateHostedReviewComposerMessage'
import { stripBaseRef } from './useCreatePullRequestDialogFields'

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

/**
 * The composer's merge target: a labelled full-width combobox whose results stay
 * attached to it, plus the base-scoped errors.
 */
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
  // Why: emptying the field is how you say "not this branch"; name where it lands so
  // the reset isn't an invisible behaviour.
  const showRepoDefaultHint = editing && trimmedQuery.length === 0 && trimmedRepoDefault.length > 0
  // Why: only claim "no branches match" once a search has actually settled, so the
  // debounce window can't report an absence the app hasn't observed yet.
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
    // Why: an emptied field commits the repo default rather than silently restoring
    // the branch the user just cleared. With no default resolved yet there is nothing
    // honest to fall back to, so the committed base stands.
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
    // Why: Enter and Escape blur the input themselves; without this they would
    // re-enter the commit path below with the pre-close query still in scope.
    if (settledRef.current) {
      settledRef.current = false
      closeSearch()
      return
    }
    // Why: clicking away from an emptied field means what pressing Enter on it
    // means — land on the repo default instead of restoring what was cleared.
    // A partial query still cancels; only an empty one is an instruction.
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
    // Why: the base owns the full sidebar width — branch names are long — and the
    // head branch rides the label row instead of costing another line.
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        {/* Why: the label holds its line and the head branch absorbs the squeeze —
            a wrapping two-word label next to a one-line ref reads as broken. */}
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
          // Why: the listbox only exists while results show, and an aria-controls
          // IDREF that resolves to nothing is worse than no reference at all.
          aria-controls={showResults ? resultsId : undefined}
          aria-activedescendant={
            showResults && activeResult >= 0 ? `${resultsId}-${activeResult}` : undefined
          }
          aria-invalid={baseSameAsBranch || undefined}
          // Why: an input can't ellipsize, and base refs routinely overflow the sidebar.
          title={editing ? undefined : base}
          value={editing ? baseQuery : base}
          disabled={fieldsLocked}
          onFocus={(event) => {
            // Why: a programmatic blur that never fired would otherwise leave the
            // flag set and swallow the next real one.
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
          // Why: the placeholder is where an emptied field lands, so it has to be the
          // repo's real default — a hardcoded "main" lies on a trunk-named repo.
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

      {/* Why: base problems belong to the base field, not to the block of
          operation errors above the submit button. */}
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
