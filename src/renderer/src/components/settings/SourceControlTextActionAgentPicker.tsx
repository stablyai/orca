import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { shallow } from 'zustand/shallow'
import { useShallow } from 'zustand/react/shallow'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useAppStore } from '@/store'
import { getIndexedReposById } from '@/store/worktree-repo-index'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId
} from '../../../../shared/execution-host'
import {
  getRepoCommitMessageModelDiscoveryHostKey,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import {
  getDiscoveredModels,
  readSourceControlAiModelChoiceForHost,
  resolveThinkingLevel
} from '../../../../shared/source-control-ai-model-selection'
import {
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlAiActionModelDefault
} from '../../../../shared/source-control-ai'
import { saveSourceControlTextPickerDraft } from './source-control-text-action-picker-save'
import { registeredRepoTextModelHostKeys } from './source-control-text-action-model-replay'
import type { SourceControlAiModelEdits } from '../../../../shared/source-control-ai-action-model-edits'
import { useTextActionModelDiscovery } from './use-text-action-model-discovery'
import { textActionPickerEntryView } from './source-control-text-action-picker-entries'
import { AI_TEXT_ACTION_IDS, type AiActionId } from '../../../../shared/source-control-ai-actions'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
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

type TextModelChange = (
  choice: SourceControlAiModelChoice | undefined,
  agentArgs: string,
  edits: SourceControlAiModelEdits | undefined
) => void

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
  onChange?: TextModelChange
  /** Saves model lists the CLI reports; without it the menu shows only saved lists. */
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

export function SourceControlTextActionAgentPicker(props: TextActionPickerProps) {
  const current = useRef(props)
  useLayoutEffect(() => {
    current.current = props
  })
  const onAgentChange = useCallback((value: string) => current.current.onAgentChange(value), [])
  const onChange = useCallback<TextModelChange>(
    (choice, args, edits) => current.current.onChange?.(choice, args, edits),
    []
  )
  const write = useCallback(
    (patch: SourceControlAiSettingsPatch) =>
      current.current.writeSourceControlAiSettings?.(patch) ?? Promise.resolve(),
    []
  )
  return (
    <TextActionPicker
      {...props}
      onAgentChange={onAgentChange}
      onChange={onChange}
      writeSourceControlAiSettings={props.writeSourceControlAiSettings ? write : undefined}
    />
  )
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
    const repoId = props.repoId
    // The cached index keeps store publications from rescanning every repository per card.
    const repo = useAppStore((state) =>
      repoId ? getIndexedReposById(state.repos, repoId)[0] : undefined
    )
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
    const hostKey = repo
      ? getRepoCommitMessageModelDiscoveryHostKey(repo)
      : LOCAL_COMMIT_MESSAGE_HOST_KEY
    const scope = props.repoId ? 'repo' : 'global'
    const discovery = useTextActionModelDiscovery(
      hostKey,
      props.repoId,
      props.writeSourceControlAiSettings
    )
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
      // The card's draft choice is what Save writes, so defaults preview clears against it.
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
      return getAgentCatalogForAction(operation, null).flatMap((agent): AgentPickerEntry[] => {
        const capability = getCommitMessageAgentCapability(agent.id)
        if (!capability) {
          return []
        }
        const discovered = getDiscoveredModels(source, legacy, hostKey, agent.id)
        const forcedSource = {
          ...ownSource,
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
                  ...(ownRepo ?? repoAi),
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
              effortArgumentsUnrecognized: false,
              effortInModel: false
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
    const ownerKey = JSON.stringify([operation, hostKey, agentArgs])
    const entries = catalogEntries.map((entry) =>
      textActionPickerEntryView(entry, ownerKey, agentArgs, discovery.listing === entry.agent)
    )
    const draftForEntry = (entry: AgentPickerEntry): AgentPickerDraft => {
      const saved = readSourceControlAiModelChoiceForHost(choice, hostKey, entry.agent)
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
          onCatalogOpen: discovery.discover,
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
              draft,
              edits: props.draft.modelEdits,
              // The preview covers today's hosts; Save covers the hosts registered when it writes.
              hostKeys: props.repoId ? [hostKey] : registeredRepoTextModelHostKeys()
            })
            props.onChange?.(saved.choice, saved.agentArgs, saved.edits)
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
