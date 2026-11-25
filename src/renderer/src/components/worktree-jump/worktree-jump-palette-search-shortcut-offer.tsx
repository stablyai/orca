import React, { memo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import {
  requestSearchShortcutChoice,
  useLegacySearchShortcutSnapshot,
  useSearchShortcutOfferState,
  type SearchShortcutOfferState
} from '@/lib/keyboard/search-shortcut-offer'
import type {
  KeybindingFileSnapshot,
  SearchShortcutChoice,
  SearchShortcutChoiceResult
} from '../../../../shared/keybindings/types'

/** macOS only: Ctrl+K on Windows/Linux also takes the shell's kill-line, so it is offered in Settings alone. */
export const WorktreeJumpPaletteSearchShortcutOffer = memo(
  function WorktreeJumpPaletteSearchShortcutOffer(): React.JSX.Element | null {
    const snapshot = useLegacySearchShortcutSnapshot()
    if (!snapshot || snapshot.platform !== 'darwin' || snapshot.searchShortcut?.choice !== null) {
      return null
    }
    return <UndecidedSearchShortcutOffer snapshot={snapshot} />
  }
)

function UndecidedSearchShortcutOffer({
  snapshot
}: {
  snapshot: KeybindingFileSnapshot
}): React.JSX.Element | null {
  const state = useSearchShortcutOfferState(snapshot)
  return state?.offer.kind === 'eligible' ? <SearchShortcutOfferPrompt state={state} /> : null
}

function SearchShortcutOfferPrompt({
  state
}: {
  state: SearchShortcutOfferState
}): React.JSX.Element {
  const t = useTranslate()
  const setSearchShortcutChoice = useAppStore((s) => s.setSearchShortcutChoice)
  const mountedRef = useMountedRef()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const keys = { key: state.searchKeyLabel, legacyKey: state.legacyKeyLabel }

  const choose = async (choice: SearchShortcutChoice): Promise<void> => {
    setPending(true)
    setFailed(false)
    const outcome = await requestSearchShortcutChoice(setSearchShortcutChoice, choice)
    if (choice === 'dismissed') {
      if (outcome === 'unconfirmed') {
        // The dismissal may be live, which unmounts this footer, so feedback must outlive it.
        showUnconfirmedToast(t)
      } else if (outcome !== 'applied' && mountedRef.current) {
        setFailed(true)
      }
    } else if (outcome === 'applied' || outcome === 'superseded') {
      // The footer unmounts with the new snapshot, so confirmation and Undo move to a toast.
      toast.success(
        outcome === 'applied'
          ? t('searchShortcutOptIn.acceptedToast', '{{key}} now opens Search', keys)
          : t(
              'searchShortcutOptIn.supersededToast',
              '{{key}} was just assigned to another shortcut',
              keys
            ),
        {
          description:
            outcome === 'superseded'
              ? t(
                  'searchShortcutOptIn.supersededDetail',
                  'Your later change was kept. See Settings › Shortcuts.'
                )
              : undefined,
          action: {
            label: t('searchShortcutOptIn.undo', 'Undo'),
            onClick: () => void undoSearchShortcut(setSearchShortcutChoice, t)
          }
        }
      )
    } else if (outcome === 'unconfirmed') {
      showUnconfirmedToast(t)
    } else if (mountedRef.current) {
      setFailed(true)
    }
    if (mountedRef.current) {
      setPending(false)
    }
  }

  return (
    <div
      role="group"
      aria-label={t('searchShortcutOptIn.groupLabel', 'Search shortcut')}
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      {/* Wraps instead of truncating: the terminal-clear cost must stay visible next to the button. */}
      <span className="min-w-0 leading-snug" aria-live="polite">
        {failed ? (
          <span className="text-destructive">
            {t('searchShortcutOptIn.failed', "Couldn't switch. Your shortcuts are unchanged.")}
          </span>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {t('searchShortcutOptIn.footerQuestion', 'Use {{key}} for Search?', keys)}
            </span>{' '}
            {t(
              'searchShortcutOptIn.footerDetail',
              '{{key}} in terminals will stop clearing.',
              keys
            )}
            {state.offer.kind === 'eligible' && state.offer.keepsLegacyKey
              ? ` ${t('searchShortcutOptIn.legacyKeeps', '{{legacyKey}} keeps working.', keys)}`
              : null}
          </>
        )}
      </span>
      {/* Keep focus in the palette input so typing continues after a click. */}
      <Button
        size="xs"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={keepButtonKeysFromPalette}
        onClick={() => void choose('accepted')}
      >
        {t('searchShortcutOptIn.use', 'Use {{key}}', keys)}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={keepButtonKeysFromPalette}
        onClick={() => void choose('dismissed')}
      >
        {t('searchShortcutOptIn.notNow', 'Not now')}
      </Button>
    </div>
  )
}

async function undoSearchShortcut(
  setSearchShortcutChoice: (
    choice: SearchShortcutChoice
  ) => Promise<SearchShortcutChoiceResult['outcome']>,
  t: ReturnType<typeof useTranslate>
): Promise<void> {
  const outcome = await requestSearchShortcutChoice(setSearchShortcutChoice, 'dismissed')
  if (outcome === 'applied') {
    // Later explicit edits survive Undo, so name the result, not specific chords.
    toast(
      t(
        'searchShortcutOptIn.undoneToast',
        'Undone. Settings › Shortcuts shows the active Search shortcut.'
      )
    )
  } else if (outcome === 'unconfirmed') {
    showUnconfirmedToast(t)
  } else {
    toast.error(
      t('searchShortcutOptIn.undoFailed', "Couldn't undo. Try again in Settings › Shortcuts.")
    )
  }
}

// Possibly saved: claim nothing about which key works, only where to look.
function showUnconfirmedToast(t: ReturnType<typeof useTranslate>): void {
  toast(t('searchShortcutOptIn.unconfirmedToast', "Couldn't confirm the change"), {
    description: t(
      'searchShortcutOptIn.unconfirmedDetail',
      'Settings › Shortcuts shows which Search shortcut is active.'
    )
  })
}

// The palette root treats Enter/Space as "open the highlighted result"; a focused footer button must activate itself.
function keepButtonKeysFromPalette(event: React.KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.stopPropagation()
  }
}
