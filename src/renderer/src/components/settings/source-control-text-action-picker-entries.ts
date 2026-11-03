import { translate } from '@/i18n/i18n'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { removeSourceControlAiArgumentFlag } from '../../../../shared/source-control-ai-argument-flags'

/** Per-render facts for a text entry: its default row label and what the card's Arguments own. */
export function textActionPickerEntryView(
  entry: AgentPickerEntry,
  ownerKey: string,
  agentArgs: string,
  listing: boolean
): AgentPickerEntry {
  const spec = getCommitMessageAgentSpec(entry.agent)!
  const model = removeSourceControlAiArgumentFlag(agentArgs, spec, 'model')
  const effort = removeSourceControlAiArgumentFlag(agentArgs, spec, 'effort')
  const defaultModel =
    entry.catalog.origin !== 'unknown'
      ? entry.catalog.models.find((model) => model.id === entry.terminal.model)
      : undefined
  const defaultLabel = translate('agentPicker.sameAsTextDefault', 'Same as default · {{value0}}', {
    value0: [
      defaultModel?.label ?? entry.terminal.model,
      defaultModel?.efforts.find((effort) => effort.value === entry.terminal.options?.effort)?.label
    ]
      .filter(Boolean)
      .join(' · ')
  })
  return {
    ...entry,
    catalog: listing ? { ...entry.catalog, listingInProgress: true as const } : entry.catalog,
    ownerKey,
    textGeneration: {
      ...entry.textGeneration!,
      defaultLabel,
      modelInArguments: model.unrecognized || model.agentArgs !== agentArgs,
      effortInArguments: effort.unrecognized || effort.agentArgs !== agentArgs,
      modelArgumentsUnrecognized: model.unrecognized,
      effortArgumentsUnrecognized: effort.unrecognized,
      effortInModel: spec.effortFlag.some((flag) => flag.modelVariant)
    }
  }
}
