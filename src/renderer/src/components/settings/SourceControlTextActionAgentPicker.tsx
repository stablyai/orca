import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { shallow } from 'zustand/shallow'
import { useShallow } from 'zustand/react/shallow'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId
} from '../../../../shared/execution-host'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import {
  getCommitMessageAgentCapability,
  getCommitMessageAgentSpec,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import {
  getDiscoveredModels,
  readSourceControlAiActionModelChoice,
  resolveThinkingLevel
} from '../../../../shared/source-control-ai-model-selection'
import {
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlAiActionModelDefault
} from '../../../../shared/source-control-ai'
import { saveSourceControlTextPickerDraft } from './source-control-text-action-picker-save'
import { removeSourceControlAiArgumentFlag } from '../../../../shared/source-control-ai-argument-flags'
import { AI_TEXT_ACTION_IDS, type AiActionId } from '../../../../shared/source-control-ai-actions'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  agentPickerDraft,
  agentPickerEffectiveChoices,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import { SourceControlActionAgentPicker } from './SourceControlActionAgentPicker'
import { getAgentCatalogForAction } from './source-control-action-recipe-options'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'
import type { TuiAgent } from '../../../../shared/tui-agent'

type TextActionPickerProps = {
  actionId: AiActionId
  agent: TuiAgent | 'custom' | null
  source?: SourceControlAiSettings
  repoId?: string
  repoAi?: RepoSourceControlAiOverrides
  draft: ActionRecipeDraftValue
  draftScope?: object
  disabled?: boolean
  defaultAgentLabel?: string
  onAgentChange: (value: string) => void
  onChange?: (choice: SourceControlAiModelChoice | undefined, agentArgs: string) => void
}

export function SourceControlTextActionAgentPicker(props: TextActionPickerProps) {
  const current = useRef(props)
  useLayoutEffect(() => {
    current.current = props
  })
  const onAgentChange = useCallback((value: string) => current.current.onAgentChange(value), [])
  const onChange = useCallback(
    (choice: SourceControlAiModelChoice | undefined, args: string) =>
      current.current.onChange?.(choice, args),
    []
  )
  return <TextActionPicker {...props} onAgentChange={onAgentChange} onChange={onChange} />
}

const TextActionPicker = memo(
  function TextActionPicker(props: TextActionPickerProps) {
    useUiLanguageRevision()
    const settings = useAppStore(
      useShallow(
        (state) =>
          state.settings && {
            sourceControlAi: state.settings.sourceControlAi,
            commitMessageAi: state.settings.commitMessageAi,
            defaultTuiAgent: state.settings.defaultTuiAgent,
            disabledTuiAgents: state.settings.disabledTuiAgents
          }
      )
    )
    const repo = useAppStore((state) => state.repos.find((repo) => repo.id === props.repoId))
    const operation = AI_TEXT_ACTION_IDS.find((id) => id === props.actionId)
    if (!operation) {
      throw new Error('Text action required')
    }
    const source = useMemo(
      () =>
        props.source ??
        normalizeSourceControlAiSettings(settings?.sourceControlAi, settings?.commitMessageAi),
      [props.source, settings?.sourceControlAi, settings?.commitMessageAi]
    )
    const host = parseRoutableExecutionHostId(repo ? getRepoExecutionHostId(repo) : 'local')
    const hostKey = getCommitMessageModelDiscoveryHostKeyForScope(
      host?.kind === 'ssh'
        ? host.targetId
        : host?.kind === 'runtime'
          ? `runtime:${host.environmentId}`
          : null
    )
    const scope = props.repoId ? 'repo' : 'global'
    const choice = props.draft.modelChoice
    const defaultAgent = settings?.defaultTuiAgent
    const disabledAgents = settings?.disabledTuiAgents
    const legacy = settings?.commitMessageAi
    const repoAi = props.repoAi
    const catalogEntries = useMemo(() => {
      const inheritedChoices = { ...source.modelOverridesByOperation }
      if (scope === 'global') {
        delete inheritedChoices[operation]
      }
      const inheritedSource = { ...source, modelOverridesByOperation: inheritedChoices }
      const repoChoices = { ...repoAi?.modelOverridesByOperation }
      if (operation !== 'conversationName') {
        delete repoChoices[operation]
      }
      const inheritedRepo = { ...repoAi, modelOverridesByOperation: repoChoices }
      const inheritedLegacy = projectSourceControlAiToLegacyCommitMessageAi(inheritedSource, legacy)
      return getAgentCatalogForAction(operation, null).flatMap((agent): AgentPickerEntry[] => {
        const capability = getCommitMessageAgentCapability(agent.id)
        if (!capability) {
          return []
        }
        const discovered = getDiscoveredModels(source, legacy, hostKey, agent.id)
        const forcedSource = {
          ...source,
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: { [hostKey]: { [agent.id]: discovered } },
          actions: {
            ...source.actions,
            [operation]: { ...source.actions?.[operation], agentId: agent.id }
          }
        }
        const forcedRepo =
          operation !== 'conversationName'
            ? {
                sourceControlAi: {
                  ...repoAi,
                  actionOverrides: {
                    ...repoAi?.actionOverrides,
                    [operation]: { ...repoAi?.actionOverrides?.[operation], agentId: agent.id }
                  }
                }
              }
            : null
        const inherited = resolveSourceControlAiActionModelDefault(
          {
            settings: {
              sourceControlAi: forcedSource,
              commitMessageAi: legacy,
              defaultTuiAgent: defaultAgent
            },
            repo: forcedRepo,
            operation,
            discoveryHostKey: hostKey
          },
          scope
        )
        const params = inherited.ok ? inherited.value.params : undefined
        const models = new Map(
          [...discovered, ...capability.models].map((model) => [model.id, model])
        )
        const ownSource =
          scope === 'global'
            ? {
                ...source,
                modelOverridesByOperation: {
                  ...source.modelOverridesByOperation,
                  [operation]: choice
                }
              }
            : source
        const ownRepo =
          scope === 'repo'
            ? {
                ...repoAi,
                modelOverridesByOperation: {
                  ...repoAi?.modelOverridesByOperation,
                  [operation]: choice
                }
              }
            : undefined
        const effortByModel = Object.fromEntries(
          [...models.values()].map((model) => [
            model.id,
            resolveThinkingLevel({
              model,
              source: ownSource,
              legacy,
              repoOverrides: ownRepo,
              operation
            })
          ])
        )
        return [
          {
            agent: agent.id,
            label: agent.label,
            rows: [{ agent: agent.id, kind: 'cli' }],
            surfaces: ['terminal'],
            defaultSurface: 'terminal',
            arguments: '',
            terminal: {
              model: params?.model ?? capability.defaultModelId,
              ...(params?.thinkingLevel ? { options: { effort: params.thinkingLevel } } : {})
            },
            structured: {},
            textGeneration: {
              defaultLabel: '',
              effortByModel,
              modelInArguments: false,
              effortInArguments: false,
              modelArgumentsUnrecognized: false,
              effortArgumentsUnrecognized: false
            },
            catalog: {
              origin: 'probe',
              fetchedAt: 0,
              models: [...models.values()].map((model) => ({
                id: model.id,
                label: model.label,
                isDefault: model.id === params?.model,
                efforts:
                  model.thinkingLevels?.map((level) => ({ value: level.id, label: level.label })) ??
                  [],
                defaultEffort: resolveThinkingLevel({
                  model,
                  source: inheritedSource,
                  legacy: inheritedLegacy,
                  repoOverrides: inheritedRepo,
                  operation
                })
              }))
            }
          }
        ]
      })
    }, [source, repoAi, operation, scope, hostKey, choice, defaultAgent, legacy])
    const agentArgs = props.draft.agentArgs ?? ''
    const entries = catalogEntries.map((entry) => {
      const spec = getCommitMessageAgentSpec(entry.agent)!
      const model = removeSourceControlAiArgumentFlag(agentArgs, spec, 'model')
      const effort = removeSourceControlAiArgumentFlag(agentArgs, spec, 'effort')
      const defaultModel =
        entry.catalog.origin !== 'unknown'
          ? entry.catalog.models.find((model) => model.id === entry.terminal.model)
          : undefined
      const defaultLabel = translate(
        'agentPicker.sameAsTextDefault',
        'Same as default · {{value0}}',
        {
          value0: [
            defaultModel?.label ?? entry.terminal.model,
            defaultModel?.efforts.find((effort) => effort.value === entry.terminal.options?.effort)
              ?.label
          ]
            .filter(Boolean)
            .join(' · ')
        }
      )
      return {
        ...entry,
        ownerKey: JSON.stringify([operation, hostKey, agentArgs]),
        textGeneration: {
          ...entry.textGeneration!,
          defaultLabel,
          modelInArguments: model.unrecognized || model.agentArgs !== agentArgs,
          effortInArguments: effort.unrecognized || effort.agentArgs !== agentArgs,
          modelArgumentsUnrecognized: model.unrecognized,
          effortArgumentsUnrecognized: effort.unrecognized
        }
      }
    })
    const draftForEntry = (entry: AgentPickerEntry): AgentPickerDraft => {
      const saved = readSourceControlAiActionModelChoice(choice, hostKey, entry.agent)
      const models = entry.catalog.origin !== 'unknown' ? entry.catalog.models : []
      const selectedModel =
        saved && !models.some((model) => model.id === saved)
          ? getCommitMessageAgentCapability(entry.agent)?.defaultModelId
          : saved
      const model = selectedModel ?? entry.terminal.model
      const effort = entry.textGeneration?.effortByModel[model ?? '']
      return {
        ...agentPickerDraft(entry),
        arguments: '',
        choices: {
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(effort ? { options: { effort } } : {})
        }
      }
    }
    const resolvedAgent = resolveCommitMessageAgentChoice(props.agent, defaultAgent, disabledAgents)
    const activeAgent = resolvedAgent && !isCustomAgentId(resolvedAgent) ? resolvedAgent : null
    const active = entries.find((entry) => entry.agent === activeAgent)
    const effective = active
      ? agentPickerEffectiveChoices(active, draftForEntry(active))
      : undefined
    const model =
      active?.catalog.origin !== 'unknown'
        ? active?.catalog.models.find((model) => model.id === effective?.model)
        : undefined
    const setByArguments =
      active?.textGeneration?.modelInArguments || active?.textGeneration?.effortInArguments
    const customLabel = translate(
      'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
      'Custom command'
    )
    const triggerLabel =
      props.agent === 'custom'
        ? customLabel
        : props.agent === null && props.defaultAgentLabel
          ? props.defaultAgentLabel
          : [
              setByArguments
                ? translate('agentPicker.setByArguments', 'Set by your Arguments')
                : model?.label,
              active?.label,
              !setByArguments
                ? model?.efforts.find((effort) => effort.value === effective?.options?.effort)
                    ?.label
                : undefined
            ]
              .filter(Boolean)
              .join(' · ')
    return (
      <SourceControlActionAgentPicker
        text={{
          draftScope: props.draftScope,
          agent: activeAgent,
          disabled: props.disabled || !settings || Boolean(props.repoId && (!repo || !host)),
          entries,
          draftForEntry,
          triggerLabel:
            triggerLabel ||
            translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
              'Use default agent'
            ),
          model: {
            state: 'settled',
            rows: entries.flatMap((entry) => entry.rows),
            detection: {
              detectedIds: entries.map((entry) => entry.agent),
              isLoading: false,
              isRefreshing: false,
              detectionFailed: false,
              needsServerUpdate: false,
              refresh: async () => entries.map((entry) => entry.agent)
            }
          },
          onPick: (agent, draft, entry) => {
            if (props.agent !== agent) {
              props.onAgentChange(agent)
            }
            if (!draft || !entry || !draft.textChanges?.length) {
              return
            }
            const saved = saveSourceControlTextPickerDraft({
              source,
              repoAi,
              repoId: props.repoId,
              choice,
              agentArgs,
              operation,
              settings,
              agent,
              entry,
              draft
            })
            props.onChange?.(saved.choice, saved.agentArgs)
          },
          children: (
            <>
              <DropdownMenuItem onSelect={() => props.onAgentChange('__default_agent__')}>
                {props.defaultAgentLabel ??
                  translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
                    'Use default agent'
                  )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.onAgentChange('custom')}>
                {customLabel}
              </DropdownMenuItem>
            </>
          )
        }}
      />
    )
  },
  (a, b) =>
    shallow({ ...a, draft: undefined }, { ...b, draft: undefined }) && shallow(a.draft, b.draft)
)
