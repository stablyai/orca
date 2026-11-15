import {
  isZotzCloudFeatureAllowed,
  type ZotzCloudFeature
} from '../../../shared/zotz/zotz-network-policy'

const CLOUD_FEATURE_BY_SETTINGS_SECTION: Readonly<Record<string, ZotzCloudFeature>> = {
  'orca-account': 'login',
  artifacts: 'share',
  'share-skills': 'share'
}

export function isZotzSettingsSectionVisible(section: { id: string }): boolean {
  const feature = CLOUD_FEATURE_BY_SETTINGS_SECTION[section.id]
  return feature === undefined || isZotzCloudFeatureAllowed(feature)
}
