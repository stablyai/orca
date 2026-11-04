import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  getAgentSessionOptionLaunchCatalog,
  findCatalogModel,
  findCatalogOption
} from '../../../../../shared/agent-session/options/agent-session-option-catalog'
import { workflowModelRefusal } from '../../../../../shared/workflow/workflow-agent-validation'
import type {
  WorkflowAgentNode,
  WorkflowWorktreeMode
} from '../../../../../shared/workflow/workflow-definition-schema'
import {
  InspectorNote,
  InspectorSection,
  NumberField,
  SelectField,
  SwitchField
} from './workflow-inspector-fields'
import { useUpdateAgentProfile } from './use-workflow-node'
import { translate } from '@/i18n/i18n'

const DEFAULT_MODEL = '__agent_default__'

const WORKTREE_OPTIONS: { value: WorkflowWorktreeMode; label: string }[] = [
  {
    value: 'current',
    label: translate(
      'auto.components.workflows.inspector.AgentRuntimeSection.701dfe1953',
      'Shared workspace'
    )
  },
  {
    value: 'new-child',
    label: translate(
      'auto.components.workflows.inspector.AgentRuntimeSection.6094675fff',
      'Isolated child worktree'
    )
  },
  {
    value: 'new-top-level',
    label: translate(
      'auto.components.workflows.inspector.AgentRuntimeSection.380cb5f0a5',
      'Isolated top-level worktree'
    )
  }
]

const WORKTREE_HELP: Record<WorkflowWorktreeMode, string> = {
  current: 'Works in the run’s workspace alongside other shared agents.',
  'new-child':
    'Orca creates a child worktree, so parallel edits never collide. Git repositories only.',
  'new-top-level': 'Orca creates a separate worktree from the project. Git repositories only.'
}

export function AgentRuntimeSection({ node }: { node: WorkflowAgentNode }): React.JSX.Element {
  const update = useUpdateAgentProfile(node.id)
  const detected = useAppStore((state) => state.detectedAgentIds)
  const runtime = node.agent.runtime
  const catalog = getAgentSessionOptionLaunchCatalog(runtime.agent)
  const modelSelectable = Boolean(
    catalog?.supportsWorkerLaunchPreferences && catalog.modelApply.launchArgs
  )
  const agents = useMemo(() => {
    const entries = getAgentCatalog()
    // Detected agents first; undetected ones stay pickable for hosts this desktop cannot see.
    return [...entries].sort(
      (a, b) =>
        Number(detected?.includes(b.id) ?? false) - Number(detected?.includes(a.id) ?? false)
    )
  }, [detected])
  const effortOption =
    runtime.model && catalog
      ? findCatalogOption(findCatalogModel(catalog, runtime.model), 'effort')
      : undefined
  const effortChoices = effortOption?.kind.type === 'select' ? effortOption.kind.choices : []
  const refusal = workflowModelRefusal(node, true)
  const notDetected = detected !== null && !detected.some((agent) => agent === runtime.agent)

  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.AgentRuntimeSection.566904a53d',
        'Runtime and model'
      )}
    >
      <SelectField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.46c97150c8',
          'CLI agent'
        )}
        value={runtime.agent}
        options={agents.map((entry) => ({
          value: entry.id,
          label:
            detected && !detected.includes(entry.id)
              ? `${entry.label} (not detected here)`
              : entry.label
        }))}
        onChange={(agent) =>
          update((profile) => {
            profile.runtime = { ...profile.runtime, agent, model: null, effort: null }
          })
        }
      />
      {notDetected ? (
        <InspectorNote tone="warning">
          {runtime.agent}{' '}
          {translate(
            'auto.components.workflows.inspector.AgentRuntimeSection.7c5149ea0c',
            'was not found on this computer. A run on another host checks that host before launching.'
          )}
        </InspectorNote>
      ) : null}
      <SelectField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.41abb8a4f4',
          'Model'
        )}
        value={runtime.model ?? DEFAULT_MODEL}
        description={
          modelSelectable
            ? translate(
                'auto.components.workflows.inspector.AgentRuntimeSection.38e4e48131',
                'Orca passes the model to the agent at launch. The agent’s own default runs when unset.'
              )
            : translate(
                'auto.components.workflows.inspector.AgentRuntimeSection.3da61b9fa5',
                'This agent cannot take a model at launch; it runs the model from its own configuration.'
              )
        }
        options={[
          {
            value: DEFAULT_MODEL,
            label: translate(
              'auto.components.workflows.inspector.AgentRuntimeSection.d4db0e3197',
              'Agent default'
            )
          },
          ...(modelSelectable
            ? (catalog?.models ?? []).map((model) => ({ value: model.id, label: model.label }))
            : []),
          ...(runtime.model && !catalog?.models.some((model) => model.id === runtime.model)
            ? [
                {
                  value: runtime.model,
                  label: translate(
                    'auto.components.workflows.inspector.AgentRuntimeSection.44921944e4',
                    '{{value0}} (not in catalog)',
                    { value0: runtime.model }
                  )
                }
              ]
            : [])
        ]}
        onChange={(model) =>
          update((profile) => {
            profile.runtime = {
              ...profile.runtime,
              model: model === DEFAULT_MODEL ? null : model,
              effort: null
            }
          })
        }
      />
      {effortChoices.length > 0 ? (
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.AgentRuntimeSection.533f7bf57a',
            'Reasoning effort'
          )}
          value={runtime.effort ?? DEFAULT_MODEL}
          options={[
            {
              value: DEFAULT_MODEL,
              label: translate(
                'auto.components.workflows.inspector.AgentRuntimeSection.324352cc8f',
                'Model default'
              )
            },
            ...effortChoices.map((choice) => ({ value: choice.value, label: choice.label }))
          ]}
          onChange={(effort) =>
            update((profile) => {
              profile.runtime = {
                ...profile.runtime,
                effort: effort === DEFAULT_MODEL ? null : effort
              }
            })
          }
        />
      ) : null}
      {refusal ? (
        <InspectorNote tone={runtime.allowModelFallback ? 'warning' : 'error'}>
          {refusal}
        </InspectorNote>
      ) : null}
      <SwitchField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.67c530f605',
          'Allow model fallback'
        )}
        description={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.46882d05bd',
          'If Orca refuses the chosen model, run the agent’s default instead of failing validation.'
        )}
        checked={runtime.allowModelFallback}
        onChange={(allowModelFallback) =>
          update((profile) => {
            profile.runtime = { ...profile.runtime, allowModelFallback }
          })
        }
      />
      <SelectField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.540f21c455',
          'Workspace isolation'
        )}
        value={node.agent.placement.worktree}
        description={WORKTREE_HELP[node.agent.placement.worktree]}
        options={WORKTREE_OPTIONS}
        onChange={(worktree) =>
          update((profile) => {
            profile.placement = { worktree }
          })
        }
      />
      <NumberField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.e1a96c603e',
          'Timeout'
        )}
        description={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.19ae415e8f',
          'Orca stops the worker and fails the attempt after this long. Empty means no limit.'
        )}
        value={
          node.agent.execution.timeoutMs === null
            ? null
            : Math.round(node.agent.execution.timeoutMs / 60_000)
        }
        min={1}
        max={1440}
        suffix="minutes"
        placeholder={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.132ba3ef6b',
          'None'
        )}
        onChange={(minutes) =>
          update((profile) => {
            profile.execution = {
              ...profile.execution,
              timeoutMs: minutes === null ? null : Math.max(1, minutes) * 60_000
            }
          })
        }
      />
      <NumberField
        label={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.8344f011cf',
          'Attempts'
        )}
        description={translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.02095274c9',
          'Total tries, each a new Orca Dispatch. 1 means no automatic retry.'
        )}
        value={node.agent.execution.maxAttempts}
        min={1}
        max={5}
        onChange={(attempts) =>
          update((profile) => {
            profile.execution = {
              ...profile.execution,
              maxAttempts: Math.min(5, Math.max(1, attempts ?? 1))
            }
          })
        }
      />
      <InspectorNote>
        {translate(
          'auto.components.workflows.inspector.AgentRuntimeSection.7e892eed5e',
          'Runs on the host that owns the workspace you pick at launch. Each node runs one task at a time; the workflow-wide agent limit is in workflow settings.'
        )}
      </InspectorNote>
    </InspectorSection>
  )
}
