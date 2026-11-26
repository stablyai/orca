import { useEffect } from 'react'
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { WorktreeCardsIntroChoice } from '@/store/slices/ui/ui-slice-contract-contextual'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { trackWorktreeCardsIntroAction } from './worktree-card-style-telemetry'
import { keepNewWorktreeCards, useWorktreeCardsKeepPending } from './worktree-cards-intro-keep'
import { WorktreeCardStyleTiles } from './WorktreeCardStyleTiles'
import { WorktreeCardsIntroPanel } from './WorktreeCardsIntroPanel'

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

const HEADING_ID = 'worktree-cards-intro-notice-heading'

export function WorktreeCardsIntroNotice(): React.JSX.Element | null {
  const t = useTranslate()
  const choice = useWorktreeCardsIntroNotice()
  const saving = useWorktreeCardsKeepPending()
  if (choice === null) {
    return null
  }
  const store = useAppStore.getState
  const dismiss = (withToast: boolean): void => {
    // Why: Keep new is the commitment point; nothing may answer Classic while its write is in flight.
    if (saving) {
      return
    }
    trackWorktreeCardsIntroAction('dismissed', choice)
    store().setWorktreeCardsIntroChoice(null)
    if (withToast) {
      toast(
        t(
          'sidebar.worktreeCardsIntroNotice.laterToast',
          'Try the new cards any time from Workspace options › Card style'
        )
      )
    }
  }
  // Why no local close: the saved setting closes the note, so a failed save leaves it open to retry.
  const keep = (): void => void keepNewWorktreeCards()
  return (
    <WorktreeCardsIntroPanel labelledBy={HEADING_ID} onEscape={() => dismiss(true)}>
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-unread" />
        <p id={HEADING_ID} className="min-w-0 flex-1 text-sm font-semibold leading-snug">
          {t('sidebar.worktreeCardsIntroNotice.title', 'Try the new cards')}
        </p>
        <Button
          variant="muted-field-icon"
          size="icon-xs"
          className="-my-1 -mr-1"
          onClick={() => dismiss(true)}
          aria-disabled={saving || undefined}
          aria-label={t('sidebar.worktreeCardsIntroNotice.dismiss', 'Not now')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <p className="mt-1 mb-3 leading-snug text-muted-foreground">
        {t(
          'sidebar.worktreeCardsIntroNotice.body',
          'Agent status, unread dots and child summaries on every card.'
        )}
      </p>
      <WorktreeCardStyleTiles
        value={choice}
        disabled={saving}
        onChange={(next) => {
          if (next === choice || saving) {
            return
          }
          trackWorktreeCardsIntroAction('flipped', next)
          store().setWorktreeCardsIntroChoice(next)
        }}
      />
      <p className="mt-3 flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
        <RotateCcw aria-hidden="true" className="mt-px size-3 shrink-0" />
        <span>
          <Trans
            i18n={i18n}
            defaults={t(
              'sidebar.worktreeCardsIntroNotice.switchBack',
              'Switch back anytime in <path>Workspace options › Card style</path>'
            )}
            components={{
              path: <span className="font-semibold whitespace-nowrap text-foreground" />
            }}
          />
        </span>
      </p>
      <div className="mt-3.5 flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => dismiss(true)}
          aria-disabled={saving || undefined}
        >
          {t('sidebar.worktreeCardsIntroNotice.dismiss', 'Not now')}
        </Button>
        {choice === 'new' ? (
          // Why aria-disabled, not disabled: the pressed button keeps focus while the save runs.
          <Button
            size="sm"
            className="h-7"
            onClick={keep}
            aria-disabled={saving || undefined}
            aria-busy={saving || undefined}
          >
            {/* Why equal side slots: the spinner appears without changing the button's width. */}
            <span className="grid grid-cols-[12px_auto_12px] items-center gap-1">
              <span aria-hidden="true" className="flex">
                {saving ? (
                  <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                ) : null}
              </span>
              {t('sidebar.worktreeCardsIntroNotice.keep', 'Keep new')}
            </span>
          </Button>
        ) : (
          <Button size="sm" className="h-7" onClick={() => dismiss(false)}>
            {t('sidebar.worktreeCardsIntroNotice.useClassic', 'Use classic')}
          </Button>
        )}
      </div>
    </WorktreeCardsIntroPanel>
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
