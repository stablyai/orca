import type { JSX } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { AiCommitPrSettingsFields } from './AiCommitPrSettingsFields'
import { AiCommitPrSettingsSwitch } from './AiCommitPrSettingsSwitch'
import { useAiCommitPrSettings } from './useAiCommitPrSettings'

export function AiCommitPrSettingsCard(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const {
    config,
    selectPortalRoot,
    setSelectPortalHost,
    agentSelectValue,
    activeCapability,
    activeModel,
    activeThinking,
    isCustom,
    unsupportedAgentLabel,
    toggleAi,
    onAgentChange,
    onModelChange,
    onThinkingChange,
    writeConfig
  } = useAiCommitPrSettings()

  if (!settings) {
    return null
  }

  return (
    <div ref={setSelectPortalHost} className="rounded-xl border border-border bg-muted/20 p-3.5">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight text-foreground">
              {translate(
                'auto.components.feature.wall.AiCommitPrSettingsCard.1c0cb4fabb',
                'AI author'
              )}
            </div>
          </div>
          <AiCommitPrSettingsSwitch
            checked={config.enabled}
            label={translate(
              'auto.components.feature.wall.AiCommitPrSettingsCard.f9382b48a1',
              'Enable AI author'
            )}
            onToggle={toggleAi}
          />
        </div>

        {config.enabled ? (
          <AiCommitPrSettingsFields
            config={config}
            selectPortalRoot={selectPortalRoot}
            agentSelectValue={agentSelectValue}
            activeCapability={activeCapability}
            activeModel={activeModel}
            activeThinking={activeThinking}
            isCustom={isCustom}
            unsupportedAgentLabel={unsupportedAgentLabel}
            onAgentChange={onAgentChange}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
            writeConfig={writeConfig}
          />
        ) : null}
      </div>
    </div>
  )
}
