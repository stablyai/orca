import React, { useState } from 'react'
import { Button } from '../../ui/button'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../../store/index'
import {
  requestSearchShortcutChoice,
  useSearchShortcutOfferState,
  type SearchShortcutOfferState
} from '@/lib/keyboard/search-shortcut-offer'
import { getKeybindingDefinition } from '../../../../../shared/keybindings/definitions'
import type {
  KeybindingFileSnapshot,
  SearchShortcutChoice,
  SearchShortcutChoiceResult
} from '../../../../../shared/keybindings/types'
import type { SearchShortcutOwner } from '../../../../../shared/keybindings/search-shortcut-opt-in'
import { localizeKeybindingDefinition } from './keybinding-title-copy'

export function SearchShortcutOptInControl({
  snapshot
}: {
  snapshot: KeybindingFileSnapshot
}): React.JSX.Element | null {
  const state = useSearchShortcutOfferState(snapshot)
  return state ? <SearchShortcutOptInRow state={state} /> : null
}

type SearchKeyOption = 'legacy' | 'mod-k'

function SearchShortcutOptInRow({ state }: { state: SearchShortcutOfferState }): React.JSX.Element {
  const t = useTranslate()
  const setSearchShortcutChoice = useAppStore((s) => s.setSearchShortcutChoice)
  const mountedRef = useMountedRef()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{
    outcome: SearchShortcutChoiceResult['outcome'] | 'error'
    choice: SearchShortcutChoice
  } | null>(null)
  const accepted = state.offer.kind === 'accepted'
  // The toggle is the undo: it is offered whenever a choice can be made or reverted.
  const toggleable = accepted || state.offer.kind === 'eligible'

  const choose = async (choice: SearchShortcutChoice): Promise<void> => {
    setPending(true)
    setNotice(null)
    const outcome = await requestSearchShortcutChoice(setSearchShortcutChoice, choice)
    if (mountedRef.current) {
      // A superseded save is explained by the row's own accepted-but-taken description.
      setNotice(outcome === 'applied' || outcome === 'superseded' ? null : { outcome, choice })
      setPending(false)
    }
  }

  const title = t('searchShortcutOptIn.searchTitle', 'Search shortcut')
  return (
    <SettingsRow
      id="search-shortcut-opt-in"
      label={title}
      description={
        <>
          {describeOffer(state, t)}
          {notice?.outcome === 'unconfirmed' ? (
            <span className="block text-muted-foreground" role="status">
              {t(
                'searchShortcutOptIn.unconfirmedInSettings',
                "Couldn't confirm the change was saved. This row shows what's active now."
              )}{' '}
              {/* The toggle already shows the unsaved choice, so it can't resubmit it; the service saves a repeat again. */}
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0"
                disabled={pending}
                onClick={() => void choose(notice.choice)}
              >
                {t('searchShortcutOptIn.retry', 'Try again')}
              </Button>
            </span>
          ) : notice ? (
            <span className="block text-destructive" role="alert">
              {t('searchShortcutOptIn.failed', "Couldn't switch. Your shortcuts are unchanged.")}
            </span>
          ) : null}
        </>
      }
      control={
        toggleable ? (
          <SettingsSegmentedControl<SearchKeyOption>
            value={accepted ? 'mod-k' : 'legacy'}
            onChange={(next) => {
              if (!pending && next !== (accepted ? 'mod-k' : 'legacy')) {
                void choose(next === 'mod-k' ? 'accepted' : 'dismissed')
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              { value: 'legacy', label: state.legacyKeyLabel, disabled: pending },
              { value: 'mod-k', label: state.searchKeyLabel, disabled: pending }
            ]}
          />
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
  const mac = state.platform === 'darwin'
  switch (state.offer.kind) {
    case 'accepted':
      if (state.offer.owners.length > 0) {
        return t(
          'searchShortcutOptIn.acceptedTaken',
          '{{key}} is also assigned to {{actions}}. Change that shortcut to use {{key}} for Search, or switch back to {{legacyKey}}.',
          { ...keys, actions: ownerTitles(state.offer.owners) }
        )
      }
      if (!state.offer.searchOnModK) {
        return t(
          'searchShortcutOptIn.acceptedCustom',
          'Search uses a custom shortcut. Choosing {{legacyKey}} returns this profile to its previous Search and clear defaults.',
          keys
        )
      }
      return mac
        ? t(
            'searchShortcutOptIn.acceptedDetailMac',
            '{{key}} opens Search and no longer clears the terminal.',
            keys
          )
        : t(
            'searchShortcutOptIn.acceptedDetailOther',
            '{{key}} opens Search and no longer cuts lines in the terminal unless Shortcuts in terminal is Terminal first.',
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
    case 'eligible': {
      const cost = mac
        ? t(
            'searchShortcutOptIn.settingsCostMac',
            'If you choose {{key}}, it no longer clears the terminal.',
            keys
          )
        : t(
            'searchShortcutOptIn.settingsCostOther',
            'If you choose {{key}}, it no longer cuts lines in the terminal unless Shortcuts in terminal is Terminal first.',
            keys
          )
      const legacy = state.offer.keepsLegacyKey
        ? ` ${t('searchShortcutOptIn.legacyKeeps', '{{legacyKey}} keeps working.', keys)}`
        : ''
      return `${cost}${legacy} ${t(
        'searchShortcutOptIn.profileOnly',
        'Only this profile changes; your custom shortcuts are kept.'
      )}`
    }
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
