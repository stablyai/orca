import { ArrowDownUp, Check, ChevronDown, Sparkles, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { stripBaseRef } from './useCreatePullRequestDialogFields'

type CreateHostedReviewComposerFieldsProps = {
  copy: LocalizedHostedReviewCopy
  base: string
  setBase: (value: string) => void
  title: string
  setTitle: (value: string) => void
  body: string
  setBody: (value: string) => void
  draft: boolean
  setDraft: (value: boolean) => void
  baseQuery: string
  setBaseQuery: (value: string) => void
  baseResults: string[]
  setBaseResults: (value: string[]) => void
  baseSearchError: string | null
  generateError: string | null
  createError: string | null
  fieldsLocked: boolean
  generating: boolean
  normalizedBase: string
  strippedBranch: string
  baseSameAsBranch: boolean
}

export function CreateHostedReviewComposerFields({
  copy,
  base,
  setBase,
  title,
  setTitle,
  body,
  setBody,
  draft,
  setDraft,
  baseQuery,
  setBaseQuery,
  baseResults,
  setBaseResults,
  baseSearchError,
  generateError,
  createError,
  fieldsLocked,
  generating,
  normalizedBase,
  strippedBranch,
  baseSameAsBranch
}: CreateHostedReviewComposerFieldsProps): React.JSX.Element {
  return (
    <>
      {/* Why: a single line that shows the head->base flow plain-language so
          the user can sanity-check the merge direction at a glance. */}
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate font-mono text-foreground" title={strippedBranch}>
          {strippedBranch}
        </span>
        <ArrowDownUp className="size-3 rotate-90 shrink-0 opacity-60" aria-hidden="true" />
        <span
          className={cn(
            'truncate font-mono',
            baseSameAsBranch ? 'text-destructive' : 'text-foreground'
          )}
          title={
            normalizedBase ||
            translate('auto.components.right.sidebar.SourceControl.7a09d7f9d2', 'base')
          }
        >
          {normalizedBase ||
            translate('auto.components.right.sidebar.SourceControl.7a09d7f9d2', 'base')}
        </span>
      </div>

      <div className="relative space-y-2">
        <input
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.a6eda33521',
            '{{value0}} title',
            { value0: copy.titleLabel }
          )}
          value={title}
          disabled={fieldsLocked}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={translate('auto.components.right.sidebar.SourceControl.7d6a8f0082', 'Title')}
          className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />

        <textarea
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.a8873e1d62',
            '{{value0}} description',
            { value0: copy.titleLabel }
          )}
          rows={6}
          value={body}
          disabled={fieldsLocked}
          onChange={(event) => setBody(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.SourceControl.a0dc20fc93',
            'Description (optional)'
          )}
          className="min-h-[7.5rem] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 scrollbar-sleek"
        />

        {generating ? (
          // Why: visible scrim + status row so the user understands the title
          // and description fields will be replaced while inputs are locked.
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/40"
            aria-hidden="true"
          >
            <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
              <Sparkles className="size-3 animate-pulse text-foreground" />
              <span>
                {translate(
                  'auto.components.right.sidebar.SourceControl.9484270f45',
                  'Generating title & description…'
                )}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Why: base picker as its own labeled row so the title input can use
          the full width. The dropdown chevron makes the picker affordance
          obvious; the inline label clarifies that this is the merge target. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {translate('auto.components.right.sidebar.SourceControl.1f7119f604', 'Base')}
        </span>
        <div className="relative min-w-0 flex-1">
          <input
            aria-label={translate(
              'auto.components.right.sidebar.SourceControl.6055949c50',
              '{{value0}} base branch',
              { value0: copy.titleLabel }
            )}
            value={baseQuery || base}
            disabled={fieldsLocked}
            onChange={(event) => {
              setBaseQuery(event.target.value)
              setBase(event.target.value)
            }}
            placeholder={translate(
              'auto.components.right.sidebar.SourceControl.e64a632456',
              'main'
            )}
            className="h-7 w-full min-w-0 rounded-md border border-border bg-background px-2 pr-6 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          />
          <ChevronDown
            className="pointer-events-none absolute right-1.5 top-1.5 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
      </div>

      <label
        className={cn(
          'flex h-7 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors',
          fieldsLocked
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
        )}
      >
        <input
          type="checkbox"
          checked={draft}
          disabled={fieldsLocked}
          onChange={(event) => setDraft(event.target.checked)}
          className="size-3.5 shrink-0 rounded border-border accent-primary"
        />
        <span className="min-w-0 flex-1 truncate">
          {translate('auto.components.right.sidebar.SourceControl.78ddfd0bb4', 'Create as draft')}
        </span>
      </label>

      {baseResults.length > 0 ? (
        <div className="max-h-28 overflow-auto rounded-md border border-border p-1 scrollbar-sleek">
          {baseResults.map((ref) => (
            <button
              key={ref}
              type="button"
              disabled={fieldsLocked}
              className={cn(
                'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
                stripBaseRef(base) === ref && 'bg-accent text-accent-foreground'
              )}
              onClick={() => {
                if (fieldsLocked) {
                  return
                }
                setBase(ref)
                setBaseQuery('')
                setBaseResults([])
              }}
            >
              <span className="truncate">{ref}</span>
              {stripBaseRef(base) === ref ? <Check className="size-3" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      <CreateHostedReviewComposerMessages
        copy={copy}
        baseSameAsBranch={baseSameAsBranch}
        baseSearchError={baseSearchError}
        generateError={generateError}
        createError={createError}
      />
    </>
  )
}

function CreateHostedReviewComposerMessages({
  copy,
  baseSameAsBranch,
  baseSearchError,
  generateError,
  createError
}: {
  copy: LocalizedHostedReviewCopy
  baseSameAsBranch: boolean
  baseSearchError: string | null
  generateError: string | null
  createError: string | null
}): React.JSX.Element {
  return (
    <>
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
      {generateError ? (
        <CreateHostedReviewComposerMessage>{generateError}</CreateHostedReviewComposerMessage>
      ) : null}
      {createError ? (
        <CreateHostedReviewComposerMessage>{createError}</CreateHostedReviewComposerMessage>
      ) : null}
    </>
  )
}

function CreateHostedReviewComposerMessage({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p className="flex items-start gap-1 text-[11px] text-destructive">
      <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
