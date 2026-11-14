import React, { useState } from 'react'
import { Button } from '../../ui/button'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../../store/index'
import {
  useSearchShortcutOfferState,
  type SearchShortcutOfferState
} from '@/lib/keyboard/search-shortcut-offer'
import { getKeybindingDefinition } from '../../../../../shared/keybindings/definitions'
import type {
  KeybindingFileSnapshot,
  SearchShortcutChoice,
  SearchShortcutChoiceResult
} from '../../../../../shared/keybindings/types'
import {
  searchShortcutOptInIsEffective,
  type SearchShortcutOwner
} from '../../../../../shared/keybindings/search-shortcut-opt-in'
import { localizeKeybindingDefinition } from './keybinding-title-copy'

export function SearchShortcutOptInControl({
  snapshot
}: {
  snapshot: KeybindingFileSnapshot
}): React.JSX.Element | null {
  const state = useSearchShortcutOfferState(snapshot)
  return state ? <SearchShortcutOptInRow state={state} /> : null
}

function SearchShortcutOptInRow({ state }: { state: SearchShortcutOfferState }): React.JSX.Element {
  const t = useTranslate()
  const setSearchShortcutChoice = useAppStore((s) => s.setSearchShortcutChoice)
  const mountedRef = useMountedRef()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<SearchShortcutChoiceResult['outcome'] | 'error' | null>(null)
  const keys = { key: state.searchKeyLabel, legacyKey: state.legacyKeyLabel }
  const accepted = state.offer.kind === 'accepted'

  const choose = async (choice: SearchShortcutChoice): Promise<void> => {
    setPending(true)
    setNotice(null)
    try {
      const outcome = await setSearchShortcutChoice(choice)
      if (mountedRef.current) {
        // A superseded save is explained by the row's own accepted-but-taken description.
        setNotice(outcome === 'applied' || outcome === 'superseded' ? null : outcome)
      }
    } catch (error) {
      console.error('Failed to save Search shortcut choice:', error)
      if (mountedRef.current) {
        setNotice('error')
      }
    } finally {
      if (mountedRef.current) {
        setPending(false)
      }
    }
  }

  const description = describeOffer(state, t)
  return (
    <SettingsRow
      id="search-shortcut-opt-in"
      label={
        searchShortcutOptInIsEffective(state.offer)
          ? t('searchShortcutOptIn.acceptedTitle', 'Search uses {{key}}', keys)
          : t('searchShortcutOptIn.title', 'Use {{key}} for Search', keys)
      }
      description={
        <>
          {description}
          {notice === 'unconfirmed' ? (
            <span className="block text-muted-foreground" role="status">
              {t(
                'searchShortcutOptIn.unconfirmedInSettings',
                "Couldn't confirm the change was saved. This row shows what's active now."
              )}
            </span>
          ) : notice === 'unchanged' || notice === 'error' ? (
            <span className="block text-destructive" role="alert">
              {t('searchShortcutOptIn.failed', "Couldn't switch. Your shortcuts are unchanged.")}
            </span>
          ) : null}
        </>
      }
      control={
        accepted ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void choose('dismissed')}
          >
            {t('searchShortcutOptIn.undo', 'Undo')}
          </Button>
        ) : state.offer.kind === 'eligible' ? (
          <Button size="sm" disabled={pending} onClick={() => void choose('accepted')}>
            {t('searchShortcutOptIn.use', 'Use {{key}}', keys)}
          </Button>
        ) : null
      }
    />
  )
}

function describeOffer(
  state: SearchShortcutOfferState,
  t: ReturnType<typeof useTranslate>
): string {
  const keys = { key: state.searchKeyLabel, legacyKey: state.legacyKeyLabel }
  switch (state.offer.kind) {
    case 'accepted':
      if (state.offer.owners.length > 0) {
        return t(
          'searchShortcutOptIn.acceptedTaken',
          '{{key}} is also assigned to {{actions}}. Change that shortcut to use {{key}} for Search, or undo.',
          { ...keys, actions: ownerTitles(state.offer.owners) }
        )
      }
      return state.offer.searchOnModK
        ? t(
            'searchShortcutOptIn.acceptedDetail',
            '{{key}} no longer clears terminals. {{legacyKey}} still opens Search.',
            keys
          )
        : t(
            'searchShortcutOptIn.acceptedCustom',
            'Search uses a custom shortcut, and {{key}} no longer clears terminals. Undo restores {{legacyKey}} and {{key}} clear.',
            keys
          )
    case 'custom-search':
      return t(
        'searchShortcutOptIn.customSearch',
        'Search uses a custom shortcut. Change it in the Switch worktree row below.'
      )
    case 'conflict':
      return t(
        'searchShortcutOptIn.conflict',
        '{{key}} is assigned to {{actions}}. Change that shortcut first.',
        { ...keys, actions: ownerTitles(state.offer.owners) }
      )
    case 'file-error':
      return t(
        'searchShortcutOptIn.fileError',
        "Your keybindings file couldn't be read. Fix it or restart Orca, then try again."
      )
    case 'eligible':
      return state.platform === 'darwin'
        ? t(
            'searchShortcutOptIn.detailMac',
            'Open Search with {{key}}, like new profiles. {{key}} in terminals will stop clearing. {{legacyKey}} keeps working. Only this profile changes; your custom shortcuts are kept.',
            keys
          )
        : t(
            'searchShortcutOptIn.detailOther',
            'Open Search with {{key}}, like new profiles. In terminals {{key}} will open Search instead of clearing, and the shell no longer gets {{key}} (delete to end of line) unless Shortcuts in terminal is Terminal first. {{legacyKey}} keeps working. Only this profile changes.',
            keys
          )
  }
}

function ownerTitles(owners: readonly SearchShortcutOwner[]): string {
  return owners
    .map(({ actionId, title }) => {
      const definition = getKeybindingDefinition(actionId)
      return definition ? localizeKeybindingDefinition(definition).title : (title ?? actionId)
    })
    .join(', ')
}
