import { useMemo, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import { CUSTOM_PROMPT_PLACEHOLDER } from '../../../../../shared/source-control/ai/generation/commit-message-prompt'
import {
  CUSTOM_AGENT_ID,
  type CommitMessageAgentCapability
} from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { CommitMessageAiSettings } from '../../../../../shared/source-control/ai/generation/commit-message-ai-types'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { AgentLaunchPicker } from '../../agent/AgentLaunchPicker'
import { DropdownMenuItem } from '../../ui/dropdown-menu'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { aiCommitPrPickerDraft, commitMessagePickerModel } from './ai-commit-pr-picker'
import { useTranslate } from '@/i18n/use-translate'

type AiCommitPrSettingsFieldsProps = {
  config: CommitMessageAiSettings
  selectPortalRoot: HTMLElement | null
  activeCapability: CommitMessageAgentCapability | undefined
  isCustom: boolean
  unsupportedAgentLabel: string | null
  onAgentChange: (newAgentId: string) => void
  pickerEntries: AgentPickerEntry[]
  onPick: (agent: TuiAgent, draft?: AgentPickerDraft) => void
  writeConfig: (patch: Partial<CommitMessageAiSettings>) => void
}

export function AiCommitPrSettingsFields({
  config,
  selectPortalRoot,
  activeCapability,
  isCustom,
  unsupportedAgentLabel,
  onAgentChange,
  pickerEntries,
  onPick,
  writeConfig
}: AiCommitPrSettingsFieldsProps): JSX.Element {
  const t = useTranslate()
  const model = useMemo(() => commitMessagePickerModel(pickerEntries), [pickerEntries])
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
        <Label className="text-xs">
          {t('auto.components.feature.wall.AiCommitPrSettingsCard.29d119fe95', 'Agent')}
        </Label>
        <AgentLaunchPicker
          model={model}
          entries={pickerEntries}
          agent={activeCapability?.id ?? null}
          draftForEntry={aiCommitPrPickerDraft}
          portalContainer={selectPortalRoot}
          onPick={onPick}
          triggerLabel={
            isCustom
              ? t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')
              : undefined
          }
          emptyLabel={
            unsupportedAgentLabel
              ? t(
                  'auto.components.feature.wall.AiCommitPrSettingsCard.1f9468c5c9',
                  '{{value0}} unsupported',
                  { value0: unsupportedAgentLabel }
                )
              : t(
                  'auto.components.feature.wall.AiCommitPrSettingsCard.bd14e9c42a',
                  'Not configured'
                )
          }
        >
          <DropdownMenuItem onSelect={() => onAgentChange(CUSTOM_AGENT_ID)}>
            <Terminal className="size-3.5" />
            {t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')}
          </DropdownMenuItem>
        </AgentLaunchPicker>
        {unsupportedAgentLabel ? (
          <p className="col-start-2 text-2xs leading-snug text-muted-foreground">
            {t(
              'auto.components.feature.wall.AiCommitPrSettingsCard.unsupportedAgent',
              '{{agent}} is not supported. Choose Claude, Codex, or Custom.',
              { agent: unsupportedAgentLabel }
            )}
          </p>
        ) : null}
      </div>

      {isCustom ? (
        <div className="space-y-1.5">
          <Label htmlFor="feature-wall-ai-commit-custom-command" className="text-xs">
            {t('auto.components.feature.wall.AiCommitPrSettingsCard.9ee54037a4', 'Custom command')}
          </Label>
          <Input
            id="feature-wall-ai-commit-custom-command"
            value={config.customAgentCommand}
            onChange={(event) => writeConfig({ customAgentCommand: event.target.value })}
            placeholder={t(
              'auto.components.feature.wall.AiCommitPrSettingsCard.8d4152701a',
              'e.g. ollama run llama3.1 {{value0}}',
              { value0: CUSTOM_PROMPT_PLACEHOLDER }
            )}
            spellCheck={false}
            className="h-8 font-mono text-xs"
          />
        </div>
      ) : null}
    </div>
  )
}
