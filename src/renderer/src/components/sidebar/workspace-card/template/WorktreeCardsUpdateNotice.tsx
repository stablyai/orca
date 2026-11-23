import { useEffect, useState } from 'react'
import { ChevronRight, Folder, GitBranch, Workflow, X } from 'lucide-react'
import { Trans } from 'react-i18next'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import StatusIndicator from '../surface/StatusIndicator'
import {
  branchStatusIconClassName,
  overlayNewCardUnreadStatus
} from '../surface/WorktreeCardStatusSlot'
import { WorktreeCardStatusPill } from '../slots/WorktreeCardSlot'

/** True once, for people who already had the experimental cards on when this build arrived. */
function useWorktreeCardsUpdateNotice(): [visible: boolean, dismiss: () => void] {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.worktreeCardsUpdateNoticeSeen)
  const enabled = useAppStore((s) =>
    s.settings ? s.settings.experimentalNewWorktreeCardStyle === true : null
  )
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Why skip paired web clients: local defaults can land before the host's setting; the desktop window decides.
    if (seen || enabled === null || isPairedWebClientWindow()) {
      return
    }
    // Why mark everyone: people who opt in later start on the updated cards, so there is no change to announce.
    useAppStore.getState().markWorktreeCardsUpdateNoticeSeen()
    if (enabled) {
      setVisible(true)
    }
  }, [seen, enabled])

  return [visible && enabled === true, () => setVisible(false)]
}

const SKELETON = 'block h-2 shrink-0 rounded-full bg-foreground/[0.14]'

/** Outlines one new piece of the demo card; `unread` matches the outline to the dot it frames. */
function Callout({
  children,
  tone
}: {
  children: React.ReactNode
  tone?: 'unread'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'mr-2.5 inline-flex shrink-0 rounded-[6px] outline-1 outline-offset-2 outline-dashed',
        tone === 'unread' ? 'outline-unread' : 'outline-foreground/60'
      )}
    >
      {children}
    </span>
  )
}

function FolderChip(): React.JSX.Element {
  return (
    <span className="inline-flex h-3.5 shrink-0 items-center gap-1 rounded-[4px] border border-border px-1">
      <Folder className="size-2.5 text-muted-foreground" />
      <span className={`${SKELETON} w-3`} />
    </span>
  )
}

/** The real card's layout with placeholder text; only the new pieces are drawn for real. */
function UpdateDemo(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      aria-hidden="true"
      className="space-y-1.5 rounded-md border border-border bg-worktree-sidebar px-2 py-2 text-worktree-sidebar-foreground"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentQuestionIcon className="size-3 shrink-0" />
        <FolderChip />
        <span className={`${SKELETON} w-7`} />
        <Callout>
          <WorktreeCardStatusPill signal={{ kind: 'needs', count: 1 }} />
        </Callout>
        <span className={`${SKELETON} ml-auto w-3`} />
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-[18px]">
        <AgentStateDot state="done" title={null} />
        <span className={`${SKELETON} w-20 opacity-70`} />
      </div>
      <div className="pl-[18px]">
        <Callout>
          <span className={cn(buttonVariants({ variant: 'outline', size: 'chip' }), 'gap-1 px-1')}>
            <Workflow className="size-2.5" />
            {t('sidebar.worktreeCardsUpdateNotice.exampleChildren', '1 child')}
            <span className="inline-flex items-center gap-0.5 border-l border-border pl-1 tabular-nums text-muted-foreground">
              <StatusIndicator status="working" showTooltip={false} />1
              <StatusIndicator status="done" showTooltip={false} />1
            </span>
            <ChevronRight className="size-2.5" />
          </span>
        </Callout>
      </div>
      {/* Why a line of its own: on a card that needs you, the question icon owns the lane and hides the dot. */}
      <div className="flex min-w-0 items-center gap-1.5 border-t border-border pt-1.5 pb-0.5">
        {/* Why negative margins: the real 20px lane, pulled toward the lines above without clipping its outline. */}
        <span className="-my-1 -mr-2.5 -ml-0.5 inline-flex">
          <Callout tone="unread">
            {overlayNewCardUnreadStatus(
              <span className="inline-flex size-5 items-center justify-center p-0.5">
                <GitBranch className={branchStatusIconClassName} />
              </span>,
              true
            )}
          </Callout>
        </span>
        <FolderChip />
        <span className={`${SKELETON} w-12 bg-foreground/[0.38]`} />
        <span className={`${SKELETON} ml-auto w-3 bg-foreground/[0.38]`} />
      </div>
    </div>
  )
}

/** One caption, led by the glyph it explains. */
function KeyItem({
  glyph,
  children
}: {
  glyph: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-1.5">
      <span aria-hidden="true" className="flex h-lh w-5 shrink-0 items-center justify-center">
        {glyph}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

export function WorktreeCardsUpdateNotice(): React.JSX.Element | null {
  const t = useTranslate()
  const [visible, dismiss] = useWorktreeCardsUpdateNotice()
  if (!visible) {
    return null
  }
  return (
    // Why a bordered floating surface: like a tooltip, it must stand apart from the sidebar it sits on.
    <section
      aria-labelledby="worktree-cards-update-notice-heading"
      className="relative mx-2 mt-1 mb-4 shrink-0 space-y-2 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-floating"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex opacity-70">
            <Badge variant="paneLabel">
              {t('sidebar.worktreeCardsUpdateNotice.newLabel', 'New')}
            </Badge>
          </span>
          <p
            id="worktree-cards-update-notice-heading"
            className="text-xs font-semibold leading-snug"
          >
            {t('sidebar.worktreeCardsUpdateNotice.title', 'Worktree cards')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-my-1 -mr-1"
          onClick={dismiss}
          aria-label={t('sidebar.worktreeCardsUpdateNotice.dismiss', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <UpdateDemo />
      <ul className="space-y-1 text-xs leading-snug">
        <KeyItem
          glyph={<span className="size-[7px] rounded-full bg-unread ring-2 ring-unread/30" />}
        >
          <Trans
            i18n={i18n}
            defaults={t(
              'sidebar.worktreeCardsUpdateNotice.unreadCaption',
              '<label>Blue dot:</label> unread'
            )}
            components={{ label: <span className="font-semibold" /> }}
          />
        </KeyItem>
        <KeyItem glyph={<AgentQuestionIcon className="size-3" />}>
          {t('sidebar.worktreeCardsUpdateNotice.statusCaption', 'Title flags agents that need you')}
        </KeyItem>
        <KeyItem
          glyph={
            <span className="inline-flex h-3 items-center rounded-[3px] border border-foreground/45 px-0.5">
              <Workflow className="size-2" />
            </span>
          }
        >
          {t('sidebar.worktreeCardsUpdateNotice.childrenCaption', 'Parents sum up child worktrees')}
        </KeyItem>
      </ul>
      {/* Why: points down at the cards this note describes. */}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] left-4 size-2.5 rotate-45 rounded-[2px] bg-popover"
      />
    </section>
  )
}
