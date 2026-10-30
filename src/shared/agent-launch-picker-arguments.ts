import type { TuiAgent } from './tui-agent'
import type { analyzeAgentChoiceArgs } from './agent-choice-args'
import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import {
  agentPickerArgumentPermission,
  agentPickerPermissionValue
} from './agent-launch-picker-permission'
import {
  agentPickerArgumentsText,
  agentPickerEffectiveChoices,
  type AgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'

export type AgentArgsProjectionContext = {
  readonly agent: TuiAgent
  readonly snapshot: object
  readonly literalKeys: readonly string[]
  readonly source: string
  readonly analysis: ReturnType<typeof analyzeAgentChoiceArgs>
  readonly occurrences: ReturnType<typeof reconcileAgentChoiceArgsDetailed>['recognized']
  readonly permission: ReturnType<typeof agentPickerArgumentPermission>
}

/** Read existing literals without authoring or rewriting the saved recipe on open. */
export function agentPickerPanelArguments(entry: AgentPickerEntry, draft: AgentPickerDraft) {
  const text = agentPickerArgumentsText(entry, draft) ?? ''
  const catalog = getAgentSessionOptionLaunchCatalog(entry.agent)
  const result = reconcileAgentChoiceArgsDetailed({
    agent: entry.agent,
    userArgs: text,
    choices: agentPickerEffectiveChoices(entry, draft),
    mode: 'load',
    keys: new Set(
      [
        'model',
        'permissionMode',
        ...(catalog?.unknownModelOptions ?? []).map((option) => option.id),
        ...(catalog?.models.flatMap((model) => model.options.map((option) => option.id)) ?? [])
      ].filter((key) => {
        const explicit =
          key === 'model'
            ? draft.choices.model
            : key === 'permissionMode'
              ? draft.choices.permissionMode
              : draft.choices.options?.[key]
        return (
          !draft.delegated?.includes(key) &&
          (explicit === undefined || draft.literalKeys?.includes(key))
        )
      })
    )
  })
  const permission = agentPickerArgumentPermission(entry, draft)
  const carriers = result.recognized
  const literal = result.analysis.cut(carriers)
  const displayed =
    permission && !permission.opaque
      ? result.analysis.cut([
          ...carriers.filter((item) => item.key !== 'permissionMode'),
          ...permission.ranges
        ])
      : literal
  return {
    text: draft.pendingArguments ?? displayed ?? result.userArgs,
    choices: result.sourceChoices,
    context: {
      agent: entry.agent,
      snapshot: draft,
      literalKeys: [
        ...new Set([
          ...(draft.literalKeys ?? []),
          ...carriers.flatMap((item) =>
            (item.key === 'model'
              ? draft.choices.model
              : item.key === 'permissionMode'
                ? draft.choices.permissionMode
                : draft.choices.options?.[item.key]) === undefined
              ? [item.key]
              : []
          )
        ])
      ],
      source: text,
      analysis: result.analysis,
      occurrences: literal === null ? [] : carriers,
      permission:
        draft.choices.permissionMode &&
        permission?.choice &&
        !draft.literalKeys?.includes('permissionMode')
          ? undefined
          : permission
    } satisfies AgentArgsProjectionContext,
    permission: permission?.value ?? agentPickerPermissionValue(entry, draft),
    selectedPermission: permission ? permission.choice : result.choices.permissionMode
  }
}
