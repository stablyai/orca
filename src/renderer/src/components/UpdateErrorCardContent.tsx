import { useId, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  Minus,
  Network,
  RotateCw,
  ShieldAlert
} from 'lucide-react'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'

export type UpdateErrorCardAction = {
  label: string
  pendingLabel?: string
  isPending?: boolean
  disabled?: boolean
  onClick: () => void
}

export type UpdateErrorCardModel = {
  variant?: 'default' | 'http1Compatibility' | 'security'
  title: string
  summary: string
  /** Optional guidance box between the summary and the raw error output. */
  explainer?: string
  /** Raw error text, shown only when the user expands "Show details". */
  detail?: string
  releaseUrl?: string
  /** Overrides the secondary button label (defaults to "Download Manually"). */
  manualLabel?: string
  primaryAction?: UpdateErrorCardAction
  /** Outline button rendered beside the primary action, before any release-URL fallback. */
  secondaryAction?: UpdateErrorCardAction
  /** Link-style action rendered on its own row below the buttons. */
  tertiaryAction?: UpdateErrorCardAction
  /** Short line under the actions — a copy confirmation or a recoverable action failure. */
  footnote?: { text: string; tone?: 'muted' | 'destructive' }
}

function ActionButton({
  action,
  variant,
  leadingIcon
}: {
  action: UpdateErrorCardAction
  variant: 'default' | 'outline'
  leadingIcon?: React.ReactNode
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={action.onClick}
      // Why: hashing a 160 MB package takes seconds, and a native `disabled` would blur the button the
      // user just pressed. The handlers self-guard, so keep focus and mark the state instead.
      aria-disabled={action.isPending || action.disabled}
      // Why: ui/button styles only `disabled:`, so aria-disabled needs its own dimming or a busy
      // action looks fully live while it silently refuses.
      className="flex-1 gap-1.5 aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      {action.isPending ? <Loader2 className="size-3.5 animate-spin" /> : leadingIcon}
      {action.isPending && action.pendingLabel ? action.pendingLabel : action.label}
    </Button>
  )
}

export function UpdateErrorCardContent({
  variant = 'default',
  title,
  summary,
  explainer,
  detail,
  releaseUrl,
  manualLabel,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  footnote,
  onClose
}: UpdateErrorCardModel & { onClose: () => void }) {
  // Why: raw error starts collapsed so the card leads with the plain summary, not a stack dump.
  const [showDetails, setShowDetails] = useState(false)
  const detailId = useId()
  const isCompatibility = variant === 'http1Compatibility'
  const isSecurity = variant === 'security'
  const Icon = isCompatibility ? Network : isSecurity ? ShieldAlert : AlertCircle
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50 ${
            isSecurity
              ? 'border-destructive/30 text-destructive'
              : 'border-border text-muted-foreground'
          }`}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.8acbdd3961', 'Minimize to status bar')}
        >
          <Minus className="size-3.5" />
        </Button>
      </div>

      {explainer ? (
        <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
          <p className="text-xs leading-relaxed text-muted-foreground">{explainer}</p>
        </div>
      ) : null}

      {/* Caret disclosure that reveals the raw error while the plain summary stays the lead. */}
      {detail ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-2 self-start text-muted-foreground hover:text-foreground"
            onClick={() => setShowDetails((prev) => !prev)}
            aria-expanded={showDetails}
            aria-controls={detailId}
          >
            <ChevronRight
              className={`size-3.5 transition-transform motion-reduce:transition-none ${showDetails ? 'rotate-90' : ''}`}
            />
            {showDetails
              ? translate('auto.components.UpdateCard.5194358929', 'Hide details')
              : translate('auto.components.UpdateCard.8bc9e17d8f', 'Show details')}
          </Button>
          {showDetails ? (
            <div id={detailId} className="rounded-md bg-muted/40 px-3 py-2">
              <p className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                {translate('auto.components.UpdateCard.3553a8672f', 'Last error')}
              </p>
              <p className="scrollbar-sleek max-h-20 overflow-auto break-words font-mono text-xs leading-relaxed text-muted-foreground">
                {detail}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {primaryAction && (
            <ActionButton
              action={primaryAction}
              variant="default"
              leadingIcon={isCompatibility ? <RotateCw className="size-3.5" /> : undefined}
            />
          )}
          {secondaryAction && <ActionButton action={secondaryAction} variant="outline" />}
          {releaseUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void window.api.shell.openUrl(releaseUrl).catch((error) => {
                  console.error('[updates] failed to open the release page:', error)
                })
              }}
              className="flex-1"
            >
              {manualLabel ??
                translate('auto.components.UpdateCard.47126bcf57', 'Download Manually')}
            </Button>
          )}
        </div>
        {tertiaryAction && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="-ml-1 min-h-[44px] self-start p-0 text-xs aria-disabled:cursor-default aria-disabled:opacity-50"
            onClick={tertiaryAction.onClick}
            aria-disabled={tertiaryAction.isPending || tertiaryAction.disabled}
          >
            {tertiaryAction.isPending && tertiaryAction.pendingLabel
              ? tertiaryAction.pendingLabel
              : tertiaryAction.label}
          </Button>
        )}
        {footnote && (
          <p
            className={`text-xs leading-relaxed ${
              footnote.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {footnote.text}
          </p>
        )}
      </div>
    </div>
  )
}
