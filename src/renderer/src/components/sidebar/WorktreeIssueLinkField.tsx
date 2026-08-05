import React, { useCallback, useId, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { ChevronDown, ExternalLink, Github, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  ISSUE_LINK_PROVIDERS,
  isIssueLinkProvider,
  type IssueLinkProvider
} from '../../../../shared/issue-link-input'

// Why: the value must clear the chip and the open-issue button that float over
// the input's right edge. Provider labels are localized, so the text share is
// measured in `ch` rather than baked into a Tailwind `pr-*` step that a longer
// translation would overlap.
const ADORNMENT_RESERVE_PX = 70
const MAX_RESERVE = '55%'

/** Exported for test: happy-dom drops `min()`, so this cannot be read back off a style. */
export function issueAdornmentReserve(providerLabel: string): string {
  return `min(calc(${ADORNMENT_RESERVE_PX}px + ${providerLabel.length}ch), ${MAX_RESERVE})`
}

function providerLabel(provider: IssueLinkProvider): string {
  return provider === 'linear'
    ? translate('auto.components.sidebar.WorktreeIssueLinkField.25852bfc59', 'Linear')
    : translate('auto.components.sidebar.WorktreeIssueLinkField.5b440069e6', 'GitHub')
}

function ProviderIcon({
  provider,
  className
}: {
  provider: IssueLinkProvider
  className?: string
}): React.JSX.Element {
  return provider === 'linear' ? (
    <LinearIcon className={className} />
  ) : (
    <Github className={className} />
  )
}

export type WorktreeIssueLinkFieldProps = {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  provider: IssueLinkProvider
  /** Set when the current value cannot be saved, so the row can explain why. */
  isInvalid: boolean
  /** Names the links this save would drop; both slots can be filled at once. */
  displacedLinkLabels: string[] | null
  /** Folder workspaces have no persisted link slots — see the design doc. */
  isReadOnly: boolean
  canOpenIssue: boolean
  openingIssue: boolean
  /** The last open attempt resolved to nothing — see useWorktreeIssueLink. */
  openIssueFailed: boolean
  onValueChange: (value: string) => void
  onProviderChange: (provider: IssueLinkProvider) => void
  onOpenIssue: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
}

export function WorktreeIssueLinkField(props: WorktreeIssueLinkFieldProps): React.JSX.Element {
  const {
    inputRef,
    value,
    provider,
    isInvalid,
    displacedLinkLabels,
    isReadOnly,
    canOpenIssue,
    openingIssue,
    openIssueFailed,
    onValueChange,
    onProviderChange,
    onOpenIssue,
    onKeyDown
  } = props

  // Why: the helper `<p>` is the only surface for the invalid and displacement
  // states, so it has to be announced with the field rather than just seen.
  const helperId = useId()
  const inputId = useId()
  const label = providerLabel(provider)
  const openIssueLabel = translate(
    'auto.components.sidebar.WorktreeIssueLinkField.161b2d053a',
    'Open linked issue'
  )

  const handleProviderChange = useCallback(
    (next: string) => {
      if (isIssueLinkProvider(next)) {
        onProviderChange(next)
      }
    },
    [onProviderChange]
  )

  const helperText = useMemo(() => {
    if (isReadOnly) {
      return translate(
        'auto.components.sidebar.WorktreeIssueLinkField.d4785f9954',
        "Issue links are set when a folder workspace is created and can't be changed here yet."
      )
    }
    if (isInvalid) {
      return provider === 'linear'
        ? translate(
            'auto.components.sidebar.WorktreeIssueLinkField.964d9bc00a',
            'Not a Linear issue key or linear.app issue URL.'
          )
        : translate(
            'auto.components.sidebar.WorktreeIssueLinkField.0a7a2c6efd',
            'Not a GitHub issue number or issue URL.'
          )
    }
    // Why: ranked above displacement because it answers the click the user just
    // made, and it clears as soon as they edit the value that caused it.
    if (openIssueFailed) {
      return provider === 'linear'
        ? translate(
            'auto.components.sidebar.WorktreeIssueLinkField.d8c8a30d1f',
            "Couldn't open that issue. Check the identifier and your Linear connection."
          )
        : translate(
            'auto.components.sidebar.WorktreeIssueLinkField.269198eeda',
            "Couldn't open that issue. Check the number and your GitHub connection."
          )
    }
    // Whole sentences per arity rather than a joined list: a translated " and "
    // fragment would not survive languages that order or punctuate lists differently.
    if (displacedLinkLabels && displacedLinkLabels.length > 1) {
      return translate(
        'auto.components.sidebar.WorktreeIssueLinkField.72486800ff',
        'Saving unlinks {{first}} and {{second}} — a workspace tracks one issue.',
        { first: displacedLinkLabels[0], second: displacedLinkLabels[1] }
      )
    }
    if (displacedLinkLabels?.length) {
      return translate(
        'auto.components.sidebar.WorktreeIssueLinkField.2c245ac134',
        'Saving unlinks {{link}} — a workspace tracks one issue.',
        { link: displacedLinkLabels[0] }
      )
    }
    return translate(
      'auto.components.sidebar.WorktreeIssueLinkField.f047887705',
      'Paste a GitHub or Linear URL, or enter a number. Leave blank to remove the link.'
    )
  }, [displacedLinkLabels, isInvalid, isReadOnly, openIssueFailed, provider])

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeIssueLinkField.ad78f9bee2', 'Issue')}
      </label>
      <div className="relative">
        <Input
          ref={inputRef}
          id={inputId}
          aria-describedby={helperId}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isReadOnly}
          aria-invalid={isInvalid || undefined}
          placeholder={translate(
            'auto.components.sidebar.WorktreeIssueLinkField.662ae142f8',
            'Issue #, or a GitHub or Linear URL'
          )}
          className="h-8 text-xs"
          style={{ paddingRight: issueAdornmentReserve(label) }}
        />
        <div className="absolute right-1 top-1 flex items-center gap-0.5">
          {/* Why: `modal` would stack a second scroll-lock layer over the
              Dialog's, whose nested teardown strands pointer-events on body. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={isReadOnly}
                aria-label={translate(
                  'auto.components.sidebar.WorktreeIssueLinkField.929c98d05a',
                  'Issue provider'
                )}
                className="h-6 px-1 text-[10px] font-medium text-muted-foreground"
              >
                <ProviderIcon provider={provider} className="size-3" />
                {label}
                <ChevronDown className="size-2.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuRadioGroup value={provider} onValueChange={handleProviderChange}>
                {ISSUE_LINK_PROVIDERS.map((item) => (
                  <DropdownMenuRadioItem key={item} value={item} className="text-xs">
                    <ProviderIcon provider={item} className="size-3" />
                    {providerLabel(item)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={openIssueLabel}
                disabled={!canOpenIssue || openingIssue}
                onClick={onOpenIssue}
                className="text-muted-foreground"
              >
                {openingIssue ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <ExternalLink className="size-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {openIssueLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {/* Why: two lines are reserved up front. The dialog is centered by
          transform, so a wrap-count change would shift the field being typed in. */}
      {/* Why: the failure and displacement messages appear without focus moving
          here, so only a live region announces them. */}
      <p
        id={helperId}
        role="status"
        aria-live="polite"
        className={cn(
          'min-h-[28px] text-[10px] leading-[14px]',
          (openIssueFailed || displacedLinkLabels?.length) && !isInvalid && !isReadOnly
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground'
        )}
      >
        {helperText}
      </p>
    </div>
  )
}
