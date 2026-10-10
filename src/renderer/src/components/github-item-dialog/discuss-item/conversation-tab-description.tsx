import React from 'react'
import { Check, LoaderCircle, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'

export function ConversationTabDescription({
  item,
  authorLabel,
  canEditBody,
  loading,
  detailsLoaded,
  bodyEditing,
  bodySaving,
  bodyChanged,
  body,
  resolvedBodyDraft,
  markdownGitHubRepo,
  setBodyDraft,
  setBodyEditing,
  onSaveBody
}: {
  item: GitHubWorkItem
  authorLabel: string
  canEditBody: boolean
  loading: boolean
  detailsLoaded: boolean
  bodyEditing: boolean
  bodySaving: boolean
  bodyChanged: boolean
  body: string
  resolvedBodyDraft: string
  markdownGitHubRepo: GitHubOwnerRepo | null
  setBodyDraft: (value: string) => void
  setBodyEditing: (value: boolean) => void
  onSaveBody: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 shadow-xs">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{authorLabel}</span>
        <span>
          {translate('auto.components.GitHubItemDialog.8223320f8d', 'updated')}{' '}
          {formatRelativeTime(item.updatedAt)}
        </span>
        {canEditBody && !loading && detailsLoaded ? (
          bodyEditing ? (
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="gap-1.5"
                disabled={bodySaving}
                onClick={() => {
                  setBodyDraft(body)
                  setBodyEditing(false)
                }}
              >
                <X className="size-3.5" />
                {translate('auto.components.GitHubItemDialog.675bc0d638', 'Cancel')}
              </Button>
              <Button
                type="button"
                size="xs"
                className="gap-1.5"
                disabled={bodySaving || !bodyChanged}
                onClick={() => void onSaveBody()}
              >
                {bodySaving ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {translate('auto.components.GitHubItemDialog.9df4e74bdf', 'Save')}
              </Button>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto size-7"
                  onClick={() => {
                    setBodyDraft(body)
                    setBodyEditing(true)
                  }}
                  aria-label={translate(
                    'auto.components.GitHubItemDialog.4d555d3796',
                    'Edit description'
                  )}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {translate('auto.components.GitHubItemDialog.4d555d3796', 'Edit description')}
              </TooltipContent>
            </Tooltip>
          )
        ) : null}
      </div>
      <div className="px-4 py-4 text-[14px] leading-relaxed text-foreground">
        {loading && !detailsLoaded ? (
          <div className="flex items-center justify-center py-5">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : bodyEditing ? (
          <GitHubMarkdownComposer
            value={resolvedBodyDraft}
            onChange={setBodyDraft}
            placeholder={translate('auto.components.GitHubItemDialog.52b20b56f7', 'Description')}
            disabled={bodySaving}
            autoFocus
            minHeightClassName="min-h-64"
            onSubmitShortcut={() => void onSaveBody()}
          />
        ) : body.trim() ? (
          <CommentMarkdown
            content={body}
            variant="document"
            githubRepo={markdownGitHubRepo}
            className="min-w-0 max-w-full overflow-hidden break-words text-[14px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
          />
        ) : (
          <span className="italic text-muted-foreground">
            {translate('auto.components.GitHubItemDialog.9b9cb55994', 'No description provided.')}
          </span>
        )}
      </div>
    </div>
  )
}
