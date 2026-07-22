import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

function localizeTip(tip: FeatureTip): FeatureTip {
  return {
    ...tip,
    eyebrow: translate(`featureTips.${tip.id}.eyebrow`, tip.eyebrow),
    title: translate(`featureTips.${tip.id}.title`, tip.title),
    description: translate(`featureTips.${tip.id}.description`, tip.description),
    ctaLabel: translate(`featureTips.${tip.id}.ctaLabel`, tip.ctaLabel)
  }
}

export const getLocalizedFeatureTips = createLocalizedCatalog(
  (): readonly FeatureTip[] => FEATURE_TIPS.map(localizeTip)
)

// Why: consumers already hold a resolved tip (picked via getFeatureTipForModal); localize in place instead of re-selecting from the catalog.
export function getLocalizedFeatureTip(tip: FeatureTip): FeatureTip {
  return localizeTip(tip)
}
