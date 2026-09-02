import { CornerDownRight, GitPullRequestArrow, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { CreateHostedReviewBasePicker } from './CreateHostedReviewBasePicker'
import { CreateHostedReviewComposerMessage } from './CreateHostedReviewComposerMessage'
import {
  COMPOSER_CHECKBOX_CLASS,
  COMPOSER_FIELD_CLASS,
  COMPOSER_TEXTAREA_CLASS
} from './create-hosted-review-composer-field-class'
import type { HostedReviewStackParent } from './useHostedReviewStackParent'

type CreateHostedReviewComposerFieldsProps = {
  copy: LocalizedHostedReviewCopy
  base: string
  setBase: (value: string) => void
  repoDefaultBase: string | null
  title: string
  setTitle: (value: string) => void
  body: string
  setBody: (value: string) => void
  draft: boolean
  setDraft: (value: boolean) => void
  supportsDraft: boolean
  stacked: boolean
  setStacked: (value: boolean) => void
  stackParentReview: HostedReviewStackParent | null
  baseQuery: string
  setBaseQuery: (value: string) => void
  baseResults: string[]
  setBaseResults: (value: string[]) => void
  baseSearchPending: boolean
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
  repoDefaultBase,
  title,
  setTitle,
  body,
  setBody,
  draft,
  setDraft,
  supportsDraft,
  stacked,
  setStacked,
  stackParentReview,
  baseQuery,
  setBaseQuery,
  baseResults,
  setBaseResults,
  baseSearchPending,
  baseSearchError,
  generateError,
  createError,
  fieldsLocked,
  generating,
  normalizedBase,
  strippedBranch,
  baseSameAsBranch
}: CreateHostedReviewComposerFieldsProps): React.JSX.Element {
  // Why: owned here, not in the picker — the stack option steps aside while the
  // base list is open so results never overlap an option about that same base.
  const [baseEditing, setBaseEditing] = useState(false)
  const draftFieldId = useId()
  const stackFieldId = useId()

  return (
    <>
      <div className="relative space-y-1.5">
        <Input
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.a6eda33521',
            '{{value0}} title',
            { value0: copy.titleLabel }
          )}
          value={title}
          disabled={fieldsLocked}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={translate('auto.components.right.sidebar.SourceControl.7d6a8f0082', 'Title')}
          className={cn(COMPOSER_FIELD_CLASS, 'px-2 font-medium')}
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
          className={cn(COMPOSER_TEXTAREA_CLASS, 'min-h-[7rem] resize-y scrollbar-sleek')}
        />

        {generating ? (
          // Why: visible scrim + status row so the user understands the title
          // and description fields will be replaced while inputs are locked.
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/40"
            aria-hidden="true"
          >
            <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground shadow-xs">
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

      <CreateHostedReviewBasePicker
        copy={copy}
        base={base}
        setBase={setBase}
        repoDefaultBase={repoDefaultBase}
        editing={baseEditing}
        setEditing={setBaseEditing}
        baseQuery={baseQuery}
        setBaseQuery={setBaseQuery}
        baseResults={baseResults}
        setBaseResults={setBaseResults}
        baseSearchPending={baseSearchPending}
        baseSearchError={baseSearchError}
        fieldsLocked={fieldsLocked}
        strippedBranch={strippedBranch}
        baseSameAsBranch={baseSameAsBranch}
      />

      <div className="space-y-2.5">
        {stackParentReview && !baseEditing ? (
          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <Checkbox
                id={stackFieldId}
                checked={stacked}
                disabled={fieldsLocked}
                onCheckedChange={(value) => setStacked(value === true)}
                className={cn(COMPOSER_CHECKBOX_CLASS, 'mt-px')}
              />
              {/* Why: the base field one row up already names the parent branch, so the
                  helper explains the effect instead of repeating the ref. */}
              <Label
                htmlFor={stackFieldId}
                className="min-w-0 flex-1 flex-col items-start gap-0.5 text-xs leading-snug"
              >
                <span className="text-foreground">
                  {translate(
                    'auto.components.right.sidebar.CreateHostedReviewComposerFields.90cabf6cfc',
                    'Stack this PR above #{{value0}}',
                    { value0: stackParentReview.number }
                  )}
                </span>
                {stacked ? null : (
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {translate(
                      'auto.components.right.sidebar.CreateHostedReviewComposerFields.ff81473a57',
                      "Creates a GitHub Stack or extends the parent's existing stack."
                    )}
                  </span>
                )}
              </Label>
            </div>

            {stacked ? (
              // Why: a single hairline instead of a nested card — the relation reads as
              // detail of the checkbox above it, not as its own framed section.
              <div className="ml-6 space-y-1 border-l border-border pl-2 text-[11px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <GitPullRequestArrow
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="shrink-0 text-muted-foreground">
                    #{stackParentReview.number}
                  </span>
                  <span className="truncate text-foreground">{normalizedBase}</span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <CornerDownRight
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate text-foreground">{strippedBranch}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {translate(
                      'auto.components.right.sidebar.CreateHostedReviewComposerFields.29732f2fb0',
                      'new PR'
                    )}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {supportsDraft ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={draftFieldId}
              checked={draft}
              disabled={fieldsLocked}
              onCheckedChange={(value) => setDraft(value === true)}
              className={COMPOSER_CHECKBOX_CLASS}
            />
            <Label htmlFor={draftFieldId} className="min-w-0 flex-1 truncate text-xs">
              {translate(
                'auto.components.right.sidebar.SourceControl.78ddfd0bb4',
                'Create as draft'
              )}
            </Label>
          </div>
        ) : null}
      </div>

      {generateError || createError ? (
        <div className="space-y-1">
          {generateError ? (
            <CreateHostedReviewComposerMessage>{generateError}</CreateHostedReviewComposerMessage>
          ) : null}
          {createError ? (
            <CreateHostedReviewComposerMessage>{createError}</CreateHostedReviewComposerMessage>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
