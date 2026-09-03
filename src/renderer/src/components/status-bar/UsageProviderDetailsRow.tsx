import React from 'react'
import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ClaudeSwitcherMenu } from './ClaudeSwitcherMenu'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'
import { GrokResetMenu } from './GrokResetMenu'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

export function UsageProviderDetailsRow({
  provider,
  row,
  compact
}: {
  provider: ProviderRateLimits
  row: React.ReactNode
  compact: boolean
}): React.ReactNode {
  // Every provider drills into its detail panel (parity with the
  // per-provider dropdowns on main); Claude/Codex additionally get
  // the account switcher + runtime toggle + Codex reset credits.
  if (provider.provider === 'claude') {
    return (
      <ClaudeSwitcherMenu
        claude={provider}
        compact={compact}
        iconOnly={false}
        asSubmenu
        triggerContent={row}
      />
    )
  }
  if (provider.provider === 'codex') {
    return (
      <CodexSwitcherMenu
        codex={provider}
        compact={compact}
        iconOnly={false}
        asSubmenu
        triggerContent={row}
      />
    )
  }
  if (provider.provider === 'grok') {
    return (
      <GrokResetMenu
        grok={provider}
        compact={compact}
        iconOnly={false}
        asSubmenu
        triggerContent={row}
      />
    )
  }
  return (
    <ProviderDetailsMenu
      provider={provider}
      compact={compact}
      iconOnly={false}
      asSubmenu
      triggerContent={row}
      ariaLabel={translate('components.usageRoster.openDetails', 'Open usage details')}
    />
  )
}
