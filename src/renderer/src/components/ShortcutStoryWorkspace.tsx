import React, { useMemo } from 'react'
import { ArrowRight, Clipboard, ExternalLink, GitBranch, LoaderCircle, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  ShortcutStoryCommentsSection,
  ShortcutStoryDescriptionSection,
  ShortcutStoryTitleSection
} from '@/components/shortcut-story-workspace-sections'
import { getShortcutStateTone } from '@/components/task-page-shortcut-status-tone'
import { useShortcutStoryWorkspaceState } from '@/components/use-shortcut-story-workspace-state'
import type { ShortcutStory, ShortcutStoryType } from '../../../shared/shortcut-types'
import { shortcutStoryReference } from '../../../shared/shortcut-story-reference'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

type ShortcutStoryWorkspaceProps = {
  story: ShortcutStory | null
  onUse: (story: ShortcutStory) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

const STORY_TYPES: ShortcutStoryType[] = ['feature', 'bug', 'chore']

export function buildShortcutBranchName(story: ShortcutStory): string {
  const slug = story.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `${shortcutStoryReference(story)}${slug ? `-${slug}` : ''}`
}

function buildShortcutPrompt(story: ShortcutStory): string {
  return `Complete Shortcut story ${shortcutStoryReference(story)}: ${story.title}\n\n${story.url}`
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.ShortcutStoryWorkspace.copied', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.ShortcutStoryWorkspace.copyFailed', 'Failed to copy {{value0}}', {
        value0: label
      })
    )
  }
}

export default function ShortcutStoryWorkspace({
  story,
  onUse,
  onClose,
  sourceContext
}: ShortcutStoryWorkspaceProps): React.JSX.Element {
  return (
    <Sheet open={story !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {story?.title ??
              translate('auto.components.ShortcutStoryWorkspace.storyTitle', 'Shortcut story')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.ShortcutStoryWorkspace.sheetDescription',
              'Preview, edit, and start work from the selected story.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {story ? (
          // Why: the key remounts the workspace per story so drafts reseed from
          // initial state instead of prop-sync effects.
          <ShortcutStoryWorkspaceContent
            key={`${story.workspaceId ?? ''}::${story.id}`}
            story={story}
            onUse={onUse}
            onClose={onClose}
            sourceContext={sourceContext}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ShortcutStoryWorkspaceContent({
  story,
  onUse,
  onClose,
  sourceContext
}: ShortcutStoryWorkspaceProps & { story: ShortcutStory }): React.JSX.Element {
  const state = useShortcutStoryWorkspaceState(story, sourceContext)
  const { displayed, mutateStory, pendingField } = state

  const actionItems = useMemo(() => {
    return [
      {
        label: translate(
          'auto.components.ShortcutStoryWorkspace.openInShortcut',
          'Open in Shortcut'
        ),
        icon: ExternalLink,
        action: () => window.api.shell.openUrl(displayed.url)
      },
      {
        label: translate('auto.components.ShortcutStoryWorkspace.copyUrl', 'Copy URL'),
        icon: Clipboard,
        action: () =>
          void copyTextToClipboard(
            displayed.url,
            translate('auto.components.ShortcutStoryWorkspace.urlLabel', 'URL')
          )
      },
      {
        label: translate('auto.components.ShortcutStoryWorkspace.copyId', 'Copy story ID'),
        icon: Clipboard,
        action: () =>
          void copyTextToClipboard(
            shortcutStoryReference(displayed),
            translate('auto.components.ShortcutStoryWorkspace.storyIdLabel', 'Story ID')
          )
      },
      {
        label: translate(
          'auto.components.ShortcutStoryWorkspace.copyBranch',
          'Copy suggested branch name'
        ),
        icon: GitBranch,
        action: () =>
          void copyTextToClipboard(
            buildShortcutBranchName(displayed),
            translate('auto.components.ShortcutStoryWorkspace.branchNameLabel', 'Branch name')
          )
      },
      {
        label: translate('auto.components.ShortcutStoryWorkspace.copyPrompt', 'Copy prompt'),
        icon: Clipboard,
        action: () =>
          void copyTextToClipboard(
            buildShortcutPrompt(displayed),
            translate('auto.components.ShortcutStoryWorkspace.promptLabel', 'Prompt')
          )
      }
    ]
  }, [displayed])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="font-mono">{shortcutStoryReference(displayed)}</span>
              {displayed.workspaceName ? <span>{displayed.workspaceName}</span> : null}
              {displayed.team?.name ? <span>{displayed.team.name}</span> : null}
              <span>{formatUiRelativeTimeFromDate(displayed.updatedAt)}</span>
              {state.storyLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
            </div>
            <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
              {displayed.title}
            </h2>
          </div>
          <Button
            onClick={() => onUse(displayed)}
            className="hidden shrink-0 gap-2 sm:inline-flex"
            size="sm"
          >
            {translate('auto.components.ShortcutStoryWorkspace.startWorkspace', 'Start workspace')}
            <ArrowRight className="size-4" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={onClose}
                aria-label={translate(
                  'auto.components.ShortcutStoryWorkspace.closePreview',
                  'Close Shortcut story preview'
                )}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.ShortcutStoryWorkspace.close', 'Close')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={pendingField === 'state' || state.workflowStates.length === 0}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
                getShortcutStateTone(displayed.state.type)
              )}
            >
              {displayed.state.name}
              {pendingField === 'state' ? <LoaderCircle className="size-3 animate-spin" /> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
            {state.workflowStates.map((workflowState) => (
              <button
                key={workflowState.id}
                type="button"
                onClick={() =>
                  void mutateStory(
                    'state',
                    { workflowStateId: workflowState.id },
                    {
                      state: {
                        id: workflowState.id,
                        name: workflowState.name,
                        type: workflowState.type
                      }
                    }
                  )
                }
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                {workflowState.name}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={pendingField === 'storyType'}
              className="rounded-md px-1.5 py-0.5 text-[11px] capitalize text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
            >
              {displayed.storyType}
              {pendingField === 'storyType' ? (
                <LoaderCircle className="ml-1 inline size-3 animate-spin" />
              ) : null}
            </button>
          </PopoverTrigger>
          <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
            {STORY_TYPES.map((storyType) => (
              <button
                key={storyType}
                type="button"
                onClick={() => void mutateStory('storyType', { storyType }, { storyType })}
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] capitalize hover:bg-accent"
              >
                {storyType}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={pendingField === 'owner'}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
            >
              {displayed.owners[0]?.name ??
                translate('auto.components.ShortcutStoryWorkspace.addOwner', '+ Owner')}
              {pendingField === 'owner' ? <LoaderCircle className="size-3 animate-spin" /> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent className="popover-scroll-content scrollbar-sleek w-56 p-1" align="start">
            <button
              type="button"
              onClick={() => void mutateStory('owner', { ownerIds: [] }, { owners: [] })}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              {translate('auto.components.ShortcutStoryWorkspace.unassigned', 'Unassigned')}
            </button>
            {state.members.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() =>
                  void mutateStory('owner', { ownerIds: [member.id] }, { owners: [member] })
                }
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt="" className="size-5 rounded-full" />
                ) : null}
                <span className="truncate">{member.name}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
        <div className="min-h-0 overflow-y-auto scrollbar-sleek">
          <ShortcutStoryTitleSection
            titleDraft={state.titleDraft}
            setTitleDraft={state.setTitleDraft}
            labelsDraft={state.labelsDraft}
            setLabelsDraft={state.setLabelsDraft}
            pendingField={pendingField}
            onSaveTitle={state.saveTitle}
            onSaveLabels={state.saveLabels}
          />
          <ShortcutStoryDescriptionSection story={displayed} />
          <ShortcutStoryCommentsSection
            comments={state.comments}
            commentsLoading={state.commentsLoading}
            commentsError={state.commentsError}
            onRetry={state.reloadComments}
          />
        </div>

        <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
          <Button
            onClick={() => onUse(displayed)}
            className="mb-3 w-full justify-center gap-2 sm:hidden"
          >
            {translate('auto.components.ShortcutStoryWorkspace.startWorkspace', 'Start workspace')}
            <ArrowRight className="size-4" />
          </Button>
          <div className="grid gap-1">
            {actionItems.map((item) => {
              const Icon = item.icon
              return (
                <Tooltip key={item.label}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={item.action}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={6}>
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </aside>
      </div>

      <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
        <div className="flex gap-2">
          <textarea
            value={state.commentDraft}
            onChange={(event) => state.setCommentDraft(event.target.value)}
            aria-label={translate(
              'auto.components.ShortcutStoryWorkspace.commentFieldLabel',
              'Add a Shortcut comment'
            )}
            placeholder={translate(
              'auto.components.ShortcutStoryWorkspace.commentPlaceholder',
              'Add a Shortcut comment...'
            )}
            rows={2}
            disabled={state.commentSubmitting}
            className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button
            onClick={() => void state.submitComment()}
            disabled={!state.canSubmitComment || state.commentSubmitting}
            className="self-end gap-2"
          >
            {state.commentSubmitting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {translate('auto.components.ShortcutStoryWorkspace.comment', 'Comment')}
          </Button>
        </div>
      </div>
    </div>
  )
}
