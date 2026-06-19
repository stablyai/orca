import React from 'react'
import { LoaderCircle, Lock, RefreshCw, Send } from 'lucide-react'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { GlpiFollowup } from '../../../shared/types'

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatGlpiRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return translate('auto.components.glpi.ticket.followups.bbf91dd6cf', 'recently')
  }
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeFormatter.format(diffHours, 'hour')
  }
  return relativeFormatter.format(Math.round(diffHours / 24), 'day')
}

type GlpiTicketFollowupsProps = {
  followups: GlpiFollowup[]
  loading: boolean
  error: string | null
  onRetry: () => void
}

export function GlpiTicketFollowups({
  followups,
  loading,
  error,
  onRetry
}: GlpiTicketFollowupsProps): React.JSX.Element {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.glpi.ticket.followups.d004456e51', 'Followups')}
          </span>
          {followups.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">{followups.length}</span>
          ) : null}
        </div>
        {error ? (
          <Button
            variant="outline"
            size="xs"
            onClick={onRetry}
            disabled={loading}
            className="gap-1"
          >
            {loading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.glpi.ticket.followups.324ad31ec9', 'Retry')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : loading && followups.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : followups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.glpi.ticket.followups.5bee9d63dc', 'No followups yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {followups.map((followup) => (
            <div key={followup.id} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {followup.user?.fullName ??
                    followup.user?.login ??
                    translate('auto.components.glpi.ticket.followups.507b68ecfe', 'Unknown')}
                </span>
                {followup.isPrivate ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="size-3" />
                    {translate('auto.components.glpi.ticket.followups.adf299616a', 'Private')}
                  </span>
                ) : null}
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatGlpiRelativeTime(followup.createdAt)}
                </span>
              </div>
              <div className="px-3 py-2">
                {/* Why: GLPI followup content is HTML; CommentMarkdown sanitizes
                    via rehype-sanitize before rendering, never raw injection. */}
                <CommentMarkdown
                  content={followup.content}
                  variant="document"
                  className="text-[13px] leading-relaxed"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

type GlpiTicketFollowupComposerProps = {
  value: string
  submitting: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}

export function GlpiTicketFollowupComposer({
  value,
  submitting,
  onChange,
  onSubmit
}: GlpiTicketFollowupComposerProps): React.JSX.Element {
  return (
    <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
      <div className="flex gap-2">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={translate(
            'auto.components.glpi.ticket.followups.c40c06e831',
            'Add a GLPI followup...'
          )}
          rows={2}
          disabled={submitting}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button
          onClick={onSubmit}
          disabled={!value.trim() || submitting}
          className="self-end gap-2"
        >
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {translate('auto.components.glpi.ticket.followups.4de419cd14', 'Followup')}
        </Button>
      </div>
    </div>
  )
}
