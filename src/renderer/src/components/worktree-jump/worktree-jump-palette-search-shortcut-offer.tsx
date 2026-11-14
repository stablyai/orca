import React, { memo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import {
  useLegacySearchShortcutSnapshot,
  useSearchShortcutOfferState,
  type SearchShortcutOfferState
} from '@/lib/keyboard/search-shortcut-offer'
import type {
  KeybindingFileSnapshot,
  SearchShortcutChoice
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
    try {
      const outcome = await setSearchShortcutChoice(choice)
      if (choice === 'accepted' && (outcome === 'applied' || outcome === 'unconfirmed')) {
        // The footer unmounts with the new snapshot, so confirmation and Undo move to a toast.
        toast.success(t('searchShortcutOptIn.acceptedToast', '{{key}} now opens Search', keys), {
          description:
            outcome === 'unconfirmed'
              ? t(
                  'searchShortcutOptIn.unconfirmed',
                  "The save wasn't confirmed. Check Settings › Shortcuts after restarting Orca."
                )
              : undefined,
          action: {
            label: t('searchShortcutOptIn.undo', 'Undo'),
            onClick: () => void setSearchShortcutChoice('dismissed').catch(() => undefined)
          }
        })
      } else if (outcome === 'unchanged' || outcome === 'refused') {
        if (mountedRef.current) {
          setFailed(true)
        }
      }
    } catch (error) {
      console.error('Failed to save Search shortcut choice:', error)
      if (mountedRef.current) {
        setFailed(true)
      }
    } finally {
      if (mountedRef.current) {
        setPending(false)
      }
    }
  }

  return (
    <div
      role="group"
      aria-label={t('searchShortcutOptIn.groupLabel', 'Search shortcut')}
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      <span className="min-w-0 truncate" aria-live="polite">
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
              '{{key}} in terminals will stop clearing. {{legacyKey}} keeps working.',
              keys
            )}
          </>
        )}
      </span>
      {/* Keep focus in the palette input so typing continues after a click. */}
      <Button
        size="xs"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void choose('accepted')}
      >
        {t('searchShortcutOptIn.use', 'Use {{key}}', keys)}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void choose('dismissed')}
      >
        {t('searchShortcutOptIn.notNow', 'Not now')}
      </Button>
    </div>
  )
}
