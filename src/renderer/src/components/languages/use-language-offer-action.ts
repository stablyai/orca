import { useState } from 'react'
import { normalizeUiLanguage } from '../../../../shared/i18n/ui-language'
import { useAppStore } from '@/store'
import type { DeviceLanguageOffer } from './device-language-offer'
import { useLanguagePackSelection } from './use-language-pack-selection'
import { useUiLanguageSelection } from './use-ui-language-selection'

/** What accepting an offer is doing right now, for progress copy. */
export type LanguageOfferProgress = 'switching' | 'preparing' | 'confirming' | 'installing' | null

/**
 * Accepts a device-language offer in place: switches to an installed match, otherwise installs
 * the catalog pack (through the globally hosted trust dialog) and switches once it is ready.
 */
export function useLanguageOfferAction(onboarding = false) {
  const uiSelection = useUiLanguageSelection({ onboarding, onClose: () => {}, disabled: false })
  const packSelection = useLanguagePackSelection(onboarding)
  const [accepting, setAccepting] = useState<DeviceLanguageOffer | null>(null)
  // The last offer accepted, so its failure can be shown and retried after it settles.
  const [lastAttempt, setLastAttempt] = useState<DeviceLanguageOffer | null>(null)
  /** Resolves true when the UI now uses the offered pack. */
  const accept = async (offer: DeviceLanguageOffer): Promise<boolean> => {
    setAccepting(offer)
    setLastAttempt(offer)
    // Why no `finally`: React Compiler cannot compile try/finally, so clear on both paths.
    try {
      if (offer.installed) {
        await uiSelection.choose(normalizeUiLanguage(offer.installed.id), offer.name)
      } else if (offer.catalog) {
        await packSelection.install(offer.catalog)
      }
    } catch (error) {
      setAccepting(null)
      throw error
    }
    setAccepting(null)
    const current = useAppStore.getState().settings?.uiLanguage
    return current === (offer.installed ?? offer.catalog)?.id
  }
  const installPhase = (offer: DeviceLanguageOffer | null) =>
    offer?.catalog ? packSelection.phaseOf(offer.catalog.listing.pluginKey) : null
  const errorFor = (offer: DeviceLanguageOffer | null): string | null => {
    const phase = installPhase(offer)
    return (
      uiSelection.error ?? packSelection.error ?? (phase?.kind === 'error' ? phase.message : null)
    )
  }
  // Why from the install phase: it reads 'preparing' while the preview loads, is null while the
  // trust dialog waits for consent, and says 'installing' only once something is installing.
  const phase = accepting ? installPhase(accepting) : null
  const progress: LanguageOfferProgress = !accepting
    ? null
    : accepting.installed
      ? 'switching'
      : phase?.kind === 'installing'
        ? 'installing'
        : phase?.kind === 'preparing'
          ? 'preparing'
          : 'confirming'
  return {
    accept,
    /** What is being accepted now, for naming it in progress copy. */
    accepting,
    lastAttempt,
    progress,
    restore: uiSelection.restore,
    choose: uiSelection.choose,
    /** Any selection in flight; disables controls, but only `progress` describes the offer. */
    busy: uiSelection.selecting !== null || packSelection.busy !== null,
    errorFor
  }
}
