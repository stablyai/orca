import React, { memo, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import {
  requestSearchShortcutChoice,
  useLegacySearchShortcutSnapshot,
  useSearchShortcutOfferState,
  type SearchShortcutOfferState
} from '@/lib/keyboard/search-shortcut-offer'
import { formatKeybindingList } from '../../../../shared/keybindings/formatting'
import type { KeybindingFileSnapshot } from '../../../../shared/keybindings/types'

type Translate = ReturnType<typeof useTranslate>
type KeyLabels = { key: string; legacyKey: string }

/** What the card shows after a choice; lives only while the palette is open, so it is shown once. */
type SettledCard =
  | { kind: 'switched'; keys: KeyLabels; keepsLegacyKey: boolean }
  | { kind: 'superseded'; keys: KeyLabels }
  | { kind: 'unconfirmed' }
  // Refused because Mod+K or Search changed since the card rendered; the card itself is gone by then.
  | { kind: 'refused' }
  | { kind: 'undone'; keys: KeyLabels }

/** Points at the Switch button while it may take Mod+Enter; the palette clicks it so disabled states hold. */
export type SearchShortcutAcceptRef = React.RefObject<HTMLButtonElement | null>

/** Undecided existing profiles only; stays until they pick Switch or Not now. */
export const WorktreeJumpPaletteSearchShortcutOffer = memo(
  function WorktreeJumpPaletteSearchShortcutOffer({
    acceptShortcutRef,
    modEnterFree
  }: {
    acceptShortcutRef: SearchShortcutAcceptRef
    /** False while a task row owns Mod+Enter, so the card neither claims nor advertises it. */
    modEnterFree: boolean
  }): React.JSX.Element | null {
    const snapshot = useLegacySearchShortcutSnapshot()
    const [settled, setSettled] = useState<SettledCard | null>(null)
    if (settled) {
      return <SearchShortcutSettledCard card={settled} onSettled={setSettled} />
    }
    if (!snapshot || snapshot.searchShortcut?.choice !== null) {
      return null
    }
    return (
      <UndecidedSearchShortcutOffer
        snapshot={snapshot}
        acceptShortcutRef={acceptShortcutRef}
        modEnterFree={modEnterFree}
        onSettled={setSettled}
      />
    )
  }
)

function UndecidedSearchShortcutOffer({
  snapshot,
  ...props
}: {
  snapshot: KeybindingFileSnapshot
  acceptShortcutRef: SearchShortcutAcceptRef
  modEnterFree: boolean
  onSettled: (card: SettledCard) => void
}): React.JSX.Element | null {
  const state = useSearchShortcutOfferState(snapshot)
  return state?.offer.kind === 'eligible' ? (
    <SearchShortcutOfferCard state={state} {...props} />
  ) : null
}

function SearchShortcutOfferCard({
  state,
  acceptShortcutRef,
  modEnterFree,
  onSettled
}: {
  state: SearchShortcutOfferState
  acceptShortcutRef: SearchShortcutAcceptRef
  modEnterFree: boolean
  onSettled: (card: SettledCard) => void
}): React.JSX.Element {
  const t = useTranslate()
  const setSearchShortcutChoice = useAppStore((s) => s.setSearchShortcutChoice)
  const mountedRef = useMountedRef()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const keys = { key: state.searchKeyLabel, legacyKey: state.legacyKeyLabel }
  const keepsLegacyKey = state.offer.kind === 'eligible' && state.offer.keepsLegacyKey
  const mac = state.platform === 'darwin'
  const title = t(
    'searchShortcutOptIn.cardTitle',
    'Switch Search from {{legacyKey}} to {{key}}?',
    keys
  )

  const choose = async (choice: 'accepted' | 'dismissed'): Promise<void> => {
    setPending(true)
    setFailed(false)
    const outcome = await requestSearchShortcutChoice(setSearchShortcutChoice, choice)
    // A live choice unmounts this card, so the settled card is owned by the parent.
    if (outcome === 'unconfirmed') {
      onSettled({ kind: 'unconfirmed' })
    } else if (choice === 'accepted' && outcome === 'applied') {
      onSettled({ kind: 'switched', keys, keepsLegacyKey })
    } else if (choice === 'accepted' && outcome === 'superseded') {
      onSettled({ kind: 'superseded', keys })
    } else if (outcome === 'refused') {
      onSettled({ kind: 'refused' })
    } else if (outcome !== 'applied' && mountedRef.current) {
      setFailed(true)
    }
    if (mountedRef.current) {
      setPending(false)
    }
  }

  return (
    <SearchShortcutCardFrame label={title} stackWhenNarrow>
      <div className="col-start-1 min-w-0 font-semibold text-foreground">{title}</div>
      <div className="col-start-2 row-start-1 flex items-center gap-1 @max-[500px]:col-start-1 @max-[500px]:row-start-3 @max-[500px]:mt-1.5 @max-[500px]:justify-self-end">
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onMouseDown={keepPaletteInputFocus}
          onKeyDown={keepButtonKeysFromPalette}
          onClick={() => void choose('dismissed')}
        >
          {t('searchShortcutOptIn.notNow', 'Not now')}
        </Button>
        <Button
          ref={modEnterFree ? acceptShortcutRef : undefined}
          size="xs"
          disabled={pending}
          onMouseDown={keepPaletteInputFocus}
          onKeyDown={keepButtonKeysFromPalette}
          onClick={() => void choose('accepted')}
        >
          {t('searchShortcutOptIn.switch', 'Switch')}
          {modEnterFree ? (
            <span className="text-3xs font-normal opacity-60">
              {formatKeybindingList(['Mod+Enter'], state.platform)}
            </span>
          ) : null}
        </Button>
      </div>
      <div className="col-span-full min-w-0 text-xs text-muted-foreground" aria-live="polite">
        {failed ? (
          <span className="text-destructive">
            {t('searchShortcutOptIn.failed', "Couldn't switch. Your shortcuts are unchanged.")}
          </span>
        ) : (
          <>
            <span className="@max-[500px]:block">
              {mac
                ? t(
                    'searchShortcutOptIn.costMac',
                    '{{key}} will no longer clear the terminal.',
                    keys
                  )
                : t(
                    'searchShortcutOptIn.costOther',
                    '{{key}} will no longer cut lines in the terminal.',
                    keys
                  )}
            </span>
            {keepsLegacyKey ? (
              <span className="@max-[500px]:block">
                {' '}
                {t('searchShortcutOptIn.legacyKeeps', '{{legacyKey}} keeps working.', keys)}
              </span>
            ) : null}
          </>
        )}
      </div>
    </SearchShortcutCardFrame>
  )
}

function SearchShortcutSettledCard({
  card,
  onSettled
}: {
  card: SettledCard
  onSettled: (card: SettledCard) => void
}): React.JSX.Element {
  const t = useTranslate()
  const setSearchShortcutChoice = useAppStore((s) => s.setSearchShortcutChoice)
  const mountedRef = useMountedRef()
  const [pending, setPending] = useState(false)
  const [undoFailed, setUndoFailed] = useState(false)
  const copy = settledCopy(card, t)

  const undo = async (keys: KeyLabels): Promise<void> => {
    setPending(true)
    setUndoFailed(false)
    const outcome = await requestSearchShortcutChoice(setSearchShortcutChoice, 'dismissed')
    if (!mountedRef.current) {
      return
    }
    setPending(false)
    if (outcome === 'applied') {
      onSettled({ kind: 'undone', keys })
    } else if (outcome === 'unconfirmed') {
      onSettled({ kind: 'unconfirmed' })
    } else {
      setUndoFailed(true)
    }
  }

  const undoKeys = card.kind === 'switched' || card.kind === 'superseded' ? card.keys : null
  return (
    <SearchShortcutCardFrame label={copy.title} muted={card.kind !== 'switched'}>
      <div className="col-start-1 flex min-w-0 items-start gap-2">
        {card.kind === 'switched' ? (
          <Check className="mt-0.5 size-3.5 shrink-0 text-foreground" aria-hidden="true" />
        ) : card.kind === 'undone' ? (
          <RotateCcw
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        <div className="min-w-0" role="status">
          <div
            className={cn(
              'text-foreground',
              card.kind === 'undone' ? 'font-medium' : 'font-semibold'
            )}
          >
            {copy.title}
          </div>
          {undoFailed || copy.detail ? (
            <div
              className={undoFailed ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {undoFailed
                ? t(
                    'searchShortcutOptIn.undoFailed',
                    "Couldn't undo. Try again in Settings › Shortcuts."
                  )
                : copy.detail}
            </div>
          ) : null}
        </div>
      </div>
      {undoKeys ? (
        <div className="col-start-2 row-start-1 flex items-center">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onMouseDown={keepPaletteInputFocus}
            onKeyDown={keepButtonKeysFromPalette}
            onClick={() => void undo(undoKeys)}
          >
            {t('searchShortcutOptIn.undo', 'Undo')}
          </Button>
        </div>
      ) : null}
    </SearchShortcutCardFrame>
  )
}

function settledCopy(card: SettledCard, t: Translate): { title: string; detail: string | null } {
  switch (card.kind) {
    case 'switched':
      return {
        title: t('searchShortcutOptIn.movedTitle', 'Search moved to {{key}}', card.keys),
        detail: card.keepsLegacyKey
          ? t('searchShortcutOptIn.legacyKeeps', '{{legacyKey}} keeps working.', card.keys)
          : null
      }
    case 'superseded':
      return {
        title: t(
          'searchShortcutOptIn.supersededTitle',
          '{{key}} was just assigned to another shortcut',
          card.keys
        ),
        detail: t(
          'searchShortcutOptIn.supersededDetail',
          'Your later change was kept. See Settings › Shortcuts.'
        )
      }
    case 'unconfirmed':
      return {
        title: t('searchShortcutOptIn.unconfirmedTitle', "Couldn't confirm the change"),
        detail: t(
          'searchShortcutOptIn.unconfirmedDetail',
          'Settings › Shortcuts shows which Search shortcut is active.'
        )
      }
    case 'refused':
      return {
        title: t('searchShortcutOptIn.failed', "Couldn't switch. Your shortcuts are unchanged."),
        detail: t('searchShortcutOptIn.refusedDetail', 'Settings › Shortcuts shows what changed.')
      }
    case 'undone':
      return {
        title: t('searchShortcutOptIn.undoneTitle', 'Search stays on {{legacyKey}}', card.keys),
        detail: null
      }
  }
}

function SearchShortcutCardFrame({
  label,
  muted = false,
  stackWhenNarrow = false,
  children
}: {
  label: string
  muted?: boolean
  /** Below 500px the buttons drop to their own right-aligned row; text wraps and never truncates. */
  stackWhenNarrow?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="@container mx-3 mt-2">
      <div
        className={cn(
          'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg border py-2 pr-2 pl-3 text-[13px]',
          muted ? 'border-border/60' : 'border-foreground/15 bg-foreground/[0.06]',
          stackWhenNarrow && '@max-[500px]:grid-cols-1'
        )}
      >
        {children}
      </div>
    </div>
  )
}

// Keep focus in the palette input so typing continues after a click.
function keepPaletteInputFocus(event: React.MouseEvent): void {
  event.preventDefault()
}

// The palette root treats Enter as "open the highlighted result"; a focused card button must activate itself.
function keepButtonKeysFromPalette(event: React.KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.stopPropagation()
  }
}
