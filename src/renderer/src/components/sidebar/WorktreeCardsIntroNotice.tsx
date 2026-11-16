import { useEffect, useRef, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { WorktreeCardsIntroChoice } from '@/store/slices/ui/ui-slice-contract-contextual'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import {
  trackWorktreeCardsIntroAction,
  trackWorktreeCardStyleChanged
} from './worktree-card-style-telemetry'

const KEPT_HINT_MS = 8000

/** Opens the note once for Classic users; the open note's switch lives in the store so it survives remounts. */
function useWorktreeCardsIntroNotice(): WorktreeCardsIntroChoice | null {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.worktreeCardsIntroNoticeSeen)
  const saved = useAppStore((s) =>
    s.settings ? s.settings.experimentalNewWorktreeCardStyle === true : null
  )
  const hasProjects = useAppStore((s) => s.repos.length > 0 || selectFolderWorkspaces(s).length > 0)
  const choice = useAppStore((s) => s.worktreeCardsIntroChoice)

  useEffect(() => {
    // Why skip paired web clients: local defaults can land before the host's setting; the desktop window decides.
    if (seen || saved === null || isPairedWebClientWindow()) {
      return
    }
    const store = useAppStore.getState()
    // A repeated effect run may still hold the stale flag.
    if (store.worktreeCardsIntroNoticeSeen) {
      return
    }
    if (saved) {
      // Why mark: people already on the new cards have nothing to try, even if they switch back later.
      store.markWorktreeCardsIntroNoticeSeen()
      return
    }
    // Why wait: the note previews the person's own cards, so it needs some to show.
    if (!hasProjects) {
      return
    }
    store.markWorktreeCardsIntroNoticeSeen()
    store.setWorktreeCardsIntroChoice('new')
    trackWorktreeCardsIntroAction('shown', 'new')
  }, [seen, saved, hasProjects])

  useEffect(() => {
    // Why: switching in the options menu or Settings while the note is open answers it.
    if (saved && choice !== null) {
      useAppStore.getState().setWorktreeCardsIntroChoice(null)
    }
  }, [saved, choice])

  return saved === false ? choice : null
}

function CardStyleSwitch({
  value,
  onChange
}: {
  value: WorktreeCardsIntroChoice
  onChange: (value: WorktreeCardsIntroChoice) => void
}): React.JSX.Element {
  const t = useTranslate()
  const refs = useRef<Record<WorktreeCardsIntroChoice, HTMLButtonElement | null>>({
    classic: null,
    new: null
  })
  const options: { value: WorktreeCardsIntroChoice; label: string }[] = [
    {
      value: 'classic',
      label: t('sidebar.worktreeCardsIntroNotice.classic', 'Classic')
    },
    { value: 'new', label: t('sidebar.worktreeCardsIntroNotice.new', 'New') }
  ]
  const select = (next: WorktreeCardsIntroChoice): void => {
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('sidebar.worktreeCardsIntroNotice.switchLabel', 'Card style')}
      className="relative isolate grid shrink-0 grid-cols-2 rounded-md bg-background/15 p-0.5"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          select('classic')
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          select('new')
        }
      }}
    >
      {/* Why one sliding thumb: the selection moves instead of blinking between two buttons. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0.5 left-0.5 -z-10 w-[calc(50%-2px)] rounded-[5px] bg-background/25 shadow-xs transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-foreground',
          value === 'new' && 'translate-x-full'
        )}
      />
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[option.value] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-[18px] min-w-11 rounded-[5px] px-1.5 text-2xs font-medium transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring',
              checked ? 'opacity-100' : 'opacity-60 hover:opacity-85'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function WorktreeCardsIntroNotice(): React.JSX.Element | null {
  const t = useTranslate()
  const choice = useWorktreeCardsIntroNotice()
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [saving, setSaving] = useState(false)
  if (choice === null) {
    return null
  }
  const store = useAppStore.getState
  const dismiss = (): void => {
    trackWorktreeCardsIntroAction('dismissed', choice)
    store().setWorktreeCardsIntroChoice(null)
    toast(
      t(
        'sidebar.worktreeCardsIntroNotice.laterToast',
        'Try the new cards any time from Workspace options › Card style'
      )
    )
  }
  const keep = (): void => {
    if (saving) {
      return
    }
    setSaving(true)
    // Why no local close: the saved setting closes the note, so a failed save leaves it open to retry.
    void updateSettings({ experimentalNewWorktreeCardStyle: true }).then(() => {
      setSaving(false)
      if (useAppStore.getState().settings?.experimentalNewWorktreeCardStyle === true) {
        trackWorktreeCardsIntroAction('kept', 'new')
        trackWorktreeCardStyleChanged(true, 'intro_note')
        store().setWorktreeCardsIntroKeptHintOpen(true)
      }
    })
  }
  return (
    // Why inverted: like a tooltip, it must stand apart from the sidebar it sits on.
    <section
      aria-labelledby="worktree-cards-intro-notice-heading"
      className="@container relative mx-2 mt-1 mb-3.5 shrink-0 rounded-lg bg-foreground/90 p-2.5 text-background shadow-floating"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          dismiss()
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Sparkles aria-hidden="true" className="size-3 shrink-0 text-unread-inverse" />
        <p
          id="worktree-cards-intro-notice-heading"
          className="flex-1 text-xs font-semibold leading-snug whitespace-nowrap"
        >
          {t('sidebar.worktreeCardsIntroNotice.title', 'New card style')}
        </p>
        <span className="shrink-0 text-2xs opacity-55 @max-[13rem]:hidden">
          {t('sidebar.worktreeCardsIntroNotice.experimental', 'Experimental')}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-my-1 -mr-1"
          onClick={dismiss}
          aria-label={t('sidebar.worktreeCardsIntroNotice.dismiss', 'Not now')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <p className="mt-0.5 mb-2.5 text-xs leading-snug opacity-70">
        {choice === 'new'
          ? t(
              'sidebar.worktreeCardsIntroNotice.previewBody',
              'Agent status, unread dots and child summaries on every card. This is a preview of your list.'
            )
          : t(
              'sidebar.worktreeCardsIntroNotice.classicBody',
              'Back to your current cards. Flip to New to preview again.'
            )}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <CardStyleSwitch
          value={choice}
          onChange={(next) => {
            if (next === choice) {
              return
            }
            trackWorktreeCardsIntroAction('flipped', next)
            store().setWorktreeCardsIntroChoice(next)
          }}
        />
        {choice === 'new' ? (
          <button
            type="button"
            onClick={keep}
            disabled={saving}
            className="ml-auto h-[22px] shrink-0 rounded-md bg-background px-2 text-2xs font-semibold whitespace-nowrap text-foreground outline-none transition-opacity hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('sidebar.worktreeCardsIntroNotice.keep', 'Keep new')}
          </button>
        ) : null}
      </div>
      {/* Why a clipped triangle, not a rotated square: overlapping the translucent note would double its tint. */}
      <span
        aria-hidden="true"
        className="absolute top-full left-4 h-[5px] w-2.5 bg-foreground/90 [clip-path:polygon(0_0,100%_0,50%_100%)]"
      />
    </section>
  )
}

/** Shown under Workspace options once someone keeps the new cards, so they know where to switch back. */
export function WorktreeCardsKeptHintContent(): React.JSX.Element {
  const t = useTranslate()
  const close = (): void => useAppStore.getState().setWorktreeCardsIntroKeptHintOpen(false)
  useEffect(() => {
    const timer = window.setTimeout(close, KEPT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <PopoverContent
      side="bottom"
      align="end"
      alignOffset={-6}
      sideOffset={8}
      tone="inverted"
      className="w-56 cursor-default"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onClick={close}
    >
      <PopoverArrow tone="inverted" />
      <div className="flex items-center gap-1.5 font-semibold">
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
        {t('sidebar.worktreeCardsIntroNotice.keptTitle', 'New cards are on')}
      </div>
      <p className="mt-0.5 pl-5 leading-snug opacity-70">
        {t('sidebar.worktreeCardsIntroNotice.keptBody', 'Change it here, under Card style.')}
      </p>
    </PopoverContent>
  )
}
