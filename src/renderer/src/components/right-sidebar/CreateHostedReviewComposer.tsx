import { useState } from 'react'
import {
  ChevronDown,
  GitMerge,
  GitPullRequestArrow,
  RefreshCw,
  Sparkles,
  Square
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import { translate } from '@/i18n/i18n'
import {
  hostedReviewProviderSupportsDraft,
  type HostedReviewProvider
} from '../../../../shared/hosted-review'
import { stripBaseRef } from './useCreatePullRequestDialogFields'
import type { HostedReviewStackParent } from './useHostedReviewStackParent'
import type { DropdownActionKind, DropdownEntry } from './source-control-dropdown-items'
import { CreateHostedReviewComposerFields } from './CreateHostedReviewComposerFields'
import { getCreateButtonLabel } from './create-hosted-review-button-label'
import {
  RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS,
  RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS,
  RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS
} from './right-sidebar-primary-action-layout'

const EMPTY_DROPDOWN_ITEMS: DropdownEntry[] = []

export type CreateHostedReviewComposerPrimaryAction = {
  disabled: boolean
  title: string
}

export type CreateHostedReviewComposerProps = {
  className?: string
  provider: HostedReviewProvider
  branch: string
  base: string
  setBase: (value: string) => void
  repoDefaultBase: string | null
  title: string
  setTitle: (value: string) => void
  body: string
  setBody: (value: string) => void
  draft: boolean
  setDraft: (value: boolean) => void
  stackedCreationSupported: boolean
  stackParentReview: HostedReviewStackParent | null
  baseQuery: string
  setBaseQuery: (value: string) => void
  baseResults: string[]
  setBaseResults: (value: string[]) => void
  baseSearchPending: boolean
  baseSearchError: string | null
  aiGenerationEnabled: boolean
  generating: boolean
  generateDisabled: boolean
  generateDisabledReason?: string
  generateError: string | null
  createError: string | null
  isCreating: boolean
  pushBeforeCreate?: boolean
  primaryAction: CreateHostedReviewComposerPrimaryAction
  dropdownItems?: DropdownEntry[]
  onGenerate: () => void
  onCancelGenerate: () => void
  onPrimaryAction: (stacked: boolean) => void
  onDropdownAction?: (kind: DropdownActionKind) => void
}

export function CreateHostedReviewComposer({
  className,
  provider,
  branch,
  base,
  setBase,
  repoDefaultBase,
  title,
  setTitle,
  body,
  setBody,
  draft,
  setDraft,
  stackedCreationSupported,
  stackParentReview,
  baseQuery,
  setBaseQuery,
  baseResults,
  setBaseResults,
  baseSearchPending,
  baseSearchError,
  aiGenerationEnabled,
  generating,
  generateDisabled,
  generateDisabledReason,
  generateError,
  createError,
  isCreating,
  pushBeforeCreate = false,
  primaryAction,
  dropdownItems,
  onGenerate,
  onCancelGenerate,
  onPrimaryAction,
  onDropdownAction
}: CreateHostedReviewComposerProps): React.JSX.Element {
  const copy = localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(provider))
  // Providers without draft reviews must not carry a stale draft flag into submit.
  const supportsDraft = hostedReviewProviderSupportsDraft(provider)
  const effectiveDraft = supportsDraft && draft
  const ReviewIcon = provider === 'gitlab' ? GitMerge : GitPullRequestArrow
  const stackedModeAvailable = provider === 'github' && stackedCreationSupported
  const normalizedBase = stripBaseRef(base)
  const stackSelectionKey = stackParentReview
    ? `${normalizedBase}:${stackParentReview.number}`
    : null
  const [stackSelection, setStackSelection] = useState({ key: '', enabled: false })
  const effectiveStacked =
    stackedModeAvailable &&
    stackSelectionKey !== null &&
    stackSelection.key === stackSelectionKey &&
    stackSelection.enabled
  const setStacked = (enabled: boolean): void => {
    setStackSelection({ key: stackSelectionKey ?? '', enabled })
  }
  const strippedBranch = stripBaseRef(branch)
  const baseSameAsBranch = normalizedBase.toLowerCase() === strippedBranch.toLowerCase()
  const createDisabled =
    primaryAction.disabled ||
    generating ||
    title.trim().length === 0 ||
    normalizedBase.trim().length === 0 ||
    baseSameAsBranch
  // Why: surface a concrete reason on the disabled Create PR button so the
  // user knows what's blocking submission instead of a silent gray state.
  let createDisabledReason: string | undefined
  if (generating) {
    createDisabledReason = translate(
      'auto.components.right.sidebar.SourceControl.318e2a7f88',
      'Wait for AI generation to finish.'
    )
  } else if (title.trim().length === 0) {
    createDisabledReason = translate(
      'auto.components.right.sidebar.SourceControl.f3a8b2c1d0e5',
      'Enter a {{value0}} title.',
      { value0: copy.reviewLabel }
    )
  } else if (normalizedBase.trim().length === 0) {
    createDisabledReason = translate(
      'auto.components.right.sidebar.SourceControl.f76307c1f7',
      'Choose a base branch.'
    )
  } else if (baseSameAsBranch) {
    createDisabledReason = translate(
      'auto.components.right.sidebar.SourceControl.4f76c0a9de',
      'Base branch must differ from the head branch.'
    )
  }

  // Why: lock the title/body/base inputs while AI generation is running so
  // the user can't race the request; generated fields only hydrate safely if
  // the hook still sees untouched field revisions.
  const fieldsLocked = generating
  const generateDetailsLabel = translate(
    'auto.components.right.sidebar.SourceControl.02d8c04339',
    'Generate {{value0}} details with AI',
    { value0: copy.reviewLabel }
  )
  const stopGeneratingDetailsLabel = translate(
    'auto.components.right.sidebar.SourceControl.b355e740b2',
    'Stop generating {{value0}} details',
    { value0: copy.reviewLabel }
  )
  const generateTooltipLabel = generating
    ? stopGeneratingDetailsLabel
    : (generateDisabledReason ?? generateDetailsLabel)
  const generateButton = generating ? (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => onCancelGenerate()}
      className="text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      aria-label={stopGeneratingDetailsLabel}
    >
      <RefreshCw className="size-3 animate-spin" />
      <span>
        {translate('auto.components.right.sidebar.SourceControl.e868cec4e1', 'Generating…')}
      </span>
      <Square className="size-2.5 fill-current" />
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={generateDisabled}
      onClick={() => onGenerate()}
      className="text-[11px] disabled:hover:bg-background"
      aria-label={generateDetailsLabel}
    >
      <Sparkles className="size-3" />
      {translate('auto.components.right.sidebar.SourceControl.aee92f8684', 'Generate')}
    </Button>
  )
  const effectiveDropdownItems = dropdownItems ?? EMPTY_DROPDOWN_ITEMS
  const showDropdown = effectiveDropdownItems.length > 0 && onDropdownAction

  return (
    <div className={cn('px-3 pb-2', className)}>
      {/* Why: one gap between groups, tighter gaps inside them — the form reads as
          content → merge target → options → action instead of a stack of boxes. */}
      <div className="space-y-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <ReviewIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground">
              {translate(
                'auto.components.right.sidebar.SourceControl.e1970d327d',
                'New {{value0}}',
                { value0: copy.reviewLabel }
              )}
            </span>
          </div>
          {aiGenerationEnabled ? (
            <Tooltip>
              {!generating && generateDisabled ? (
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 cursor-not-allowed">{generateButton}</span>
                </TooltipTrigger>
              ) : (
                <TooltipTrigger asChild>{generateButton}</TooltipTrigger>
              )}
              <TooltipContent side="left" sideOffset={6}>
                {generateTooltipLabel}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <CreateHostedReviewComposerFields
          copy={copy}
          base={base}
          setBase={setBase}
          repoDefaultBase={repoDefaultBase}
          title={title}
          setTitle={setTitle}
          body={body}
          setBody={setBody}
          draft={draft}
          setDraft={setDraft}
          supportsDraft={supportsDraft}
          stacked={effectiveStacked}
          setStacked={setStacked}
          stackParentReview={stackedModeAvailable ? stackParentReview : null}
          baseQuery={baseQuery}
          setBaseQuery={setBaseQuery}
          baseResults={baseResults}
          setBaseResults={setBaseResults}
          baseSearchPending={baseSearchPending}
          baseSearchError={baseSearchError}
          generateError={generateError}
          createError={createError}
          fieldsLocked={fieldsLocked}
          generating={generating}
          normalizedBase={normalizedBase}
          strippedBranch={strippedBranch}
          baseSameAsBranch={baseSameAsBranch}
        />

        <div className={RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS}>
          <Button
            type="button"
            size="xs"
            disabled={createDisabled}
            onClick={() => onPrimaryAction(effectiveStacked)}
            className={cn(
              'h-8 px-3 text-xs',
              showDropdown && 'rounded-r-none',
              RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS
            )}
            title={createDisabledReason ?? primaryAction.title}
          >
            {isCreating ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <ReviewIcon className="size-3.5" />
            )}
            <span className={RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS}>
              {getCreateButtonLabel({
                isCreating,
                pushBeforeCreate,
                draft: effectiveDraft,
                stacked: effectiveStacked,
                shortLabel: copy.shortLabel
              })}
            </span>
          </Button>
          {showDropdown ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="xs"
                  className={cn(
                    'h-8 rounded-l-none border-l border-primary-foreground/20 px-1.5 shrink-0',
                    createDisabled && 'opacity-50'
                  )}
                  aria-label={translate(
                    'auto.components.right.sidebar.SourceControl.c5e4175139',
                    'More {{value0}} and remote actions',
                    { value0: copy.reviewLabel }
                  )}
                  title={translate(
                    'auto.components.right.sidebar.SourceControl.4d6e1fd7f3',
                    'More actions'
                  )}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem]">
                {effectiveDropdownItems.map((entry, index) =>
                  entry.kind === 'separator' ? (
                    <DropdownMenuSeparator key={`sep-${index}`} />
                  ) : (
                    <DropdownMenuItem
                      key={entry.kind}
                      disabled={entry.disabled}
                      title={entry.title}
                      variant={entry.variant}
                      onSelect={(event) => {
                        if (entry.disabled) {
                          event.preventDefault()
                          return
                        }
                        onDropdownAction(entry.kind)
                      }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span>{entry.label}</span>
                        {entry.hint ? (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {entry.hint}
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  )
}
