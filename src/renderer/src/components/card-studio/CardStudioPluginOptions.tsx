import React, { useState } from 'react'
import { pluginSettingValueIssue } from '../../../../shared/plugins/contributions/plugin-settings-contribution'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginSidebarCards } from '@/store/plugin-sidebar-cards'
import { PluginSettingRow } from '../plugins/page/PluginSettingsSection'
import { CardStudioSection } from './CardStudioSection'

/** The selected plugin card's declared options, drawn as data with the plugin settings rows. */
export function CardStudioPluginOptions({ cardId }: { cardId: string }): React.JSX.Element | null {
  const card = usePluginSidebarCards().find((entry) => entry.id === cardId)
  const values = useAppStore((s) => s.settings?.workspaceCardOptions?.[cardId])
  const allValues = useAppStore((s) => s.settings?.workspaceCardOptions)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [errors, setErrors] = useState<Record<string, string>>({})
  if (!card?.options?.length) {
    return null
  }
  return (
    <CardStudioSection title={translate('auto.components.cardStudio.cardOptions', 'Card options')}>
      <div className="overflow-hidden rounded-md border border-border">
        {card.options.map((option) => (
          <PluginSettingRow
            key={option.key}
            setting={option}
            value={values && Object.hasOwn(values, option.key) ? values[option.key] : undefined}
            error={errors[option.key] || undefined}
            onWrite={(value) => {
              const issue = value === null ? null : pluginSettingValueIssue(option, value)
              setErrors((current) => ({ ...current, [option.key]: issue ?? '' }))
              if (issue) {
                return
              }
              const next = { ...values }
              if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
              ) {
                next[option.key] = value
              } else {
                delete next[option.key]
              }
              void updateSettings({ workspaceCardOptions: { ...allValues, [cardId]: next } })
            }}
          />
        ))}
      </div>
    </CardStudioSection>
  )
}
