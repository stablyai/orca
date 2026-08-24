import { Boxes, Cloud, Globe, Server, Shield, Sparkles, Zap } from 'lucide-react'
import type { ComponentType } from 'react'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export type CustomProviderIconOption = {
  id: string
  label: string
  Icon: ComponentType<{ className?: string }>
}

// Why: a small bundled preset catalog, never raw user SVG — avoids the
// sanitization/XSS surface entirely for a rarely-cosmetic feature.
export const getCustomProviderIconOptions = createLocalizedCatalog<CustomProviderIconOption[]>(
  () => [
    {
      id: 'server',
      label: translate('auto.components.settings.customProviderIconOptions.server', 'Server'),
      Icon: Server
    },
    {
      id: 'cloud',
      label: translate('auto.components.settings.customProviderIconOptions.cloud', 'Cloud'),
      Icon: Cloud
    },
    {
      id: 'globe',
      label: translate('auto.components.settings.customProviderIconOptions.globe', 'Globe'),
      Icon: Globe
    },
    {
      id: 'shield',
      label: translate('auto.components.settings.customProviderIconOptions.shield', 'Shield'),
      Icon: Shield
    },
    {
      id: 'zap',
      label: translate('auto.components.settings.customProviderIconOptions.zap', 'Zap'),
      Icon: Zap
    },
    {
      id: 'sparkles',
      label: translate('auto.components.settings.customProviderIconOptions.sparkles', 'Sparkles'),
      Icon: Sparkles
    },
    {
      id: 'boxes',
      label: translate('auto.components.settings.customProviderIconOptions.boxes', 'Boxes'),
      Icon: Boxes
    }
  ]
)

export const DEFAULT_CUSTOM_PROVIDER_ICON_ID = 'server'

export function getCustomProviderIconOption(id: string | undefined): CustomProviderIconOption {
  const options = getCustomProviderIconOptions()
  return options.find((option) => option.id === id) ?? options[0]
}
