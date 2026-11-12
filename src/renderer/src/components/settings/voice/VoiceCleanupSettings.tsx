import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { VoiceSettings } from '../../../../../shared/speech-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { setSourceControlActionDefault } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { CUSTOM_AGENT_ID } from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  DEFAULT_DICTATION_CORRECTION_WORD,
  dictationCorrectionWord,
  isDictationCleanupOn,
  resolveDictationCleanupAgent
} from '../../../../../shared/dictation-cleanup'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../ui/input'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SourceControlTextActionAgentPicker } from '../source-control/text-actions/SourceControlTextActionAgentPicker'
import { replayGlobalTextModelEdits } from '../source-control/text-actions/source-control-text-action-model-replay'
import { VoiceCleanupConsentDialog } from './VoiceCleanupConsentDialog'
import { VoiceCleanupInstructionsSetting } from './VoiceCleanupInstructionsSetting'

const DEFAULT_AGENT_VALUE = '__default_agent__'

type VoiceCleanupSettingsProps = {
  settings: GlobalSettings
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

function agentDisplayName(agentId: string, customLabel: string): string {
  return agentId === CUSTOM_AGENT_ID || !isTuiAgent(agentId) ? customLabel : getAgentLabel(agentId)
}

/** AI cleanup of dictated text: off by default, and asks before text first goes to an agent. */
export function VoiceCleanupSettings({
  settings,
  voiceSettings,
  onUpdateVoiceSettings,
  writeSourceControlAiSettings
}: VoiceCleanupSettingsProps): React.JSX.Element {
  const t = useTranslate()
  const correctionLabelId = useId()
  const config = useMemo(
    () => normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi),
    [settings.sourceControlAi, settings.commitMessageAi]
  )
  // Turning cleanup on, or picking an agent text hasn't gone to yet, waits for the user's OK.
  const [pending, setPending] = useState<{
    agentId: string
    selection: string | null
  } | null>(null)
  const [correctionDraft, setCorrectionDraft] = useState<string | null>(null)
  const customLabel = t(
    'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
    'Custom command'
  )
  const on = isDictationCleanupOn(settings)
  const agentId = resolveDictationCleanupAgent(settings)
  const agentLabel = agentId ? agentDisplayName(agentId, customLabel) : ''
  const recipe = config.actions?.dictationCleanup
  const selectedAgent = recipe?.agentId ?? null
  const saveFailed = (): void => {
    toast.error(t('components.settings.voice.cleanup.saveFailed', 'Could not save AI cleanup.'))
  }

  const writeAgent = (selection: string | null): Promise<void> =>
    writeSourceControlAiSettings((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'dictationCleanup', {
        agentId: selection === null ? null : isTuiAgent(selection) ? selection : CUSTOM_AGENT_ID
      })
    }))

  const pickAgent = (value: string): void => {
    const selection = value === DEFAULT_AGENT_VALUE ? null : value
    const next = resolveDictationCleanupAgent({
      ...settings,
      sourceControlAi: {
        ...config,
        actions: setSourceControlActionDefault(config.actions, 'dictationCleanup', {
          agentId: selection === null || isTuiAgent(selection) ? selection : CUSTOM_AGENT_ID
        })
      }
    })
    if (on && next && next !== voiceSettings.aiCleanupConsentAgent) {
      setPending({ agentId: next, selection })
      return
    }
    void writeAgent(selection).catch(saveFailed)
  }

  const toggle = (): void => {
    if (on) {
      onUpdateVoiceSettings({ aiCleanup: false })
    } else if (agentId && voiceSettings.aiCleanupConsentAgent === agentId) {
      onUpdateVoiceSettings({ aiCleanup: true })
    } else if (agentId) {
      setPending({ agentId, selection: selectedAgent })
    } else {
      toast.error(
        t(
          'components.settings.voice.cleanup.noAgent',
          'No agent can run AI cleanup. Pick one below.'
        )
      )
    }
  }

  const confirm = async (): Promise<void> => {
    if (!pending) {
      return
    }
    setPending(null)
    if (pending.selection !== selectedAgent) {
      await writeAgent(pending.selection)
    }
    onUpdateVoiceSettings({ aiCleanup: true, aiCleanupConsentAgent: pending.agentId })
  }

  const saveCorrectionWord = (): void => {
    if (correctionDraft !== null) {
      onUpdateVoiceSettings({ dictationCorrectionWord: correctionDraft.trim() })
      setCorrectionDraft(null)
    }
  }

  return (
    <>
      <SettingsGroup title={t('components.settings.voice.cleanup.title', 'Cleanup')}>
        <SettingsSwitchRow
          label={t('components.settings.voice.cleanup.label', 'AI cleanup')}
          description={t(
            'components.settings.voice.cleanup.description',
            'Fixes punctuation, numbers and spoken corrections before text lands. Sends the text to {{agent}}, never audio.',
            { agent: agentLabel || t('components.settings.voice.cleanup.anAgent', 'an AI agent') }
          )}
          checked={on}
          onChange={toggle}
        />
        {/* With no usable agent the picker shows while off, so one can be chosen before turning it on. */}
        {on || !agentId ? (
          <SettingsRow
            label={t('components.settings.voice.cleanup.agent', 'Agent and model')}
            description={t(
              'components.settings.voice.cleanup.agentDescription',
              'Runs on this computer. A small, fast model keeps the wait short.'
            )}
            control={
              <div className="w-[220px]">
                <SourceControlTextActionAgentPicker
                  actionId="dictationCleanup"
                  // An unset pick shows the agent cleanup really runs: Source Control AI's.
                  agent={selectedAgent ?? agentId}
                  source={config}
                  draft={{
                    commandInputTemplate: recipe?.commandInputTemplate ?? '{basePrompt}',
                    agentArgs: recipe?.agentArgs ?? '',
                    modelChoice: config.modelOverridesByOperation?.dictationCleanup
                  }}
                  onAgentChange={pickAgent}
                  onChange={(_choice, _agentArgs, edits) => {
                    if (!edits?.length) {
                      return
                    }
                    void writeSourceControlAiSettings((current) => ({
                      modelOverridesByOperation: {
                        ...current.modelOverridesByOperation,
                        dictationCleanup: replayGlobalTextModelEdits(
                          current,
                          'dictationCleanup',
                          edits
                        )
                      }
                    })).catch(saveFailed)
                  }}
                  writeSourceControlAiSettings={writeSourceControlAiSettings}
                />
              </div>
            }
          />
        ) : null}
        {on ? (
          <>
            <SettingsRow
              label={t('components.settings.voice.cleanup.correctionWord', 'Correction word')}
              labelId={correctionLabelId}
              description={t(
                'components.settings.voice.cleanup.correctionWordDescription',
                'Say it to take back what you just said: “at four, {{word}}, at five”.',
                {
                  word: dictationCorrectionWord(voiceSettings) || DEFAULT_DICTATION_CORRECTION_WORD
                }
              )}
              control={
                <Input
                  aria-labelledby={correctionLabelId}
                  className="h-8 w-40"
                  value={correctionDraft ?? dictationCorrectionWord(voiceSettings)}
                  placeholder={t('components.settings.voice.cleanup.correctionWordOff', 'None')}
                  onChange={(event) => setCorrectionDraft(event.target.value)}
                  onBlur={saveCorrectionWord}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      saveCorrectionWord()
                    }
                  }}
                />
              }
            />
            <VoiceCleanupInstructionsSetting
              instructions={voiceSettings.aiCleanupInstructions}
              onSave={(aiCleanupInstructions) => onUpdateVoiceSettings({ aiCleanupInstructions })}
            />
          </>
        ) : null}
      </SettingsGroup>
      <VoiceCleanupConsentDialog
        request={
          pending
            ? {
                agentId: pending.agentId,
                agentLabel: agentDisplayName(pending.agentId, customLabel)
              }
            : null
        }
        onCancel={() => setPending(null)}
        onConfirm={() => void confirm().catch(saveFailed)}
      />
    </>
  )
}
