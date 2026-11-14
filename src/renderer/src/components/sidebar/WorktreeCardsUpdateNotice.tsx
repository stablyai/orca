import { useEffect, useState } from 'react'
import { ChevronRight, Folder, Workflow, X } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import StatusIndicator from './workspace-card/surface/StatusIndicator'
import { WorktreeCardStatusPill } from './WorktreeCardSlot'

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

/** Numbers a new piece in the demo; the caption repeats the number. */
function Marker({ n, inverted = false }: { n: 1 | 2; inverted?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold',
        inverted ? 'bg-background text-foreground' : 'bg-foreground text-background'
      )}
    >
      {n}
    </span>
  )
}

/** Outlines one new piece of the demo card and numbers it. */
function Callout({ n, children }: { n: 1 | 2; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="relative mr-2.5 inline-flex shrink-0 rounded-[6px] outline-1 outline-offset-2 outline-foreground/60 outline-dashed">
      {children}
      <span className="absolute -top-2.5 -right-2.5">
        <Marker n={n} />
      </span>
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
        <span className="inline-flex h-3.5 shrink-0 items-center gap-1 rounded-[4px] border border-border px-1">
          <Folder className="size-2.5 text-muted-foreground" />
          <span className={`${SKELETON} w-3`} />
        </span>
        <span className={`${SKELETON} w-7`} />
        <Callout n={1}>
          <WorktreeCardStatusPill signal={{ kind: 'needs', count: 1 }} />
        </Callout>
        <span className={`${SKELETON} ml-auto w-3`} />
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-[18px]">
        <AgentStateDot state="done" title={null} />
        <span className={`${SKELETON} w-20 opacity-70`} />
      </div>
      <div className="pl-[18px]">
        <Callout n={2}>
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
    </div>
  )
}

export function WorktreeCardsUpdateNotice(): React.JSX.Element | null {
  const t = useTranslate()
  const [visible, dismiss] = useWorktreeCardsUpdateNotice()
  if (!visible) {
    return null
  }
  return (
    // Why inverted: like a tooltip, it must stand apart from the sidebar it sits on.
    <section
      aria-labelledby="worktree-cards-update-notice-heading"
      className="relative mx-2 mt-1 mb-4 shrink-0 space-y-2 rounded-lg bg-foreground p-2.5 text-background shadow-floating"
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
        <li className="flex items-start gap-1.5">
          <Marker n={1} inverted />
          {t('sidebar.worktreeCardsUpdateNotice.statusCaption', 'Title flags agents that need you')}
        </li>
        <li className="flex items-start gap-1.5">
          <Marker n={2} inverted />
          {t('sidebar.worktreeCardsUpdateNotice.childrenCaption', 'Parents sum up child worktrees')}
        </li>
      </ul>
      {/* Why: points down at the cards this note describes. */}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] left-4 size-2.5 rotate-45 rounded-[2px] bg-foreground"
      />
    </section>
  )
}
