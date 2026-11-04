import React from 'react'
import type { WorkflowPolicies } from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import {
  InspectorNote,
  InspectorSection,
  NumberField,
  SelectField,
  TextAreaField,
  TextField
} from './workflow-inspector-fields'
import { translate } from '@/i18n/i18n'

export function WorkflowSettingsInspector(): React.JSX.Element | null {
  const preset = useWorkflowEditorStore((state) => state.preset)
  const commit = useWorkflowEditorStore((state) => state.commit)
  const issues = useWorkflowEditorStore((state) => state.issues)
  if (!preset) {
    return null
  }
  const policies = preset.definition.policies
  const setPolicies = (patch: Partial<WorkflowPolicies>): void =>
    commit(
      (draft) => {
        draft.definition.policies = { ...draft.definition.policies, ...patch }
      },
      { history: false }
    )
  const nodeIssues = issues.filter((issue) => !issue.nodeId && !issue.edgeId)
  return (
    <>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.WorkflowSettingsInspector.457d07e767',
          'Workflow'
        )}
      >
        <TextField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.9b240e7ba3',
            'Name'
          )}
          value={preset.name}
          invalid={!preset.name.trim()}
          onChange={(name) =>
            commit(
              (draft) => {
                draft.name = name.slice(0, 120)
              },
              { history: false }
            )
          }
        />
        <TextAreaField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.440c9e7cd0',
            'Description'
          )}
          rows={2}
          value={preset.description}
          onChange={(description) =>
            commit(
              (draft) => {
                draft.description = description.slice(0, 2_000)
              },
              { history: false }
            )
          }
        />
        <TextAreaField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.02af629cac',
            'Default objective'
          )}
          rows={3}
          description={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.e5c7bb1bc8',
            'Prefilled when you run this workflow; available to prompts as {{objective}}.'
          )}
          value={preset.defaultRunSettings.objective}
          onChange={(objective) =>
            commit(
              (draft) => {
                draft.defaultRunSettings = { objective }
              },
              { history: false }
            )
          }
        />
        <TextAreaField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.26f7ab25c5',
            'Shared instructions'
          )}
          rows={4}
          description={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.fe670e90bd',
            'Added to every agent that includes shared instructions.'
          )}
          value={policies.sharedInstructions}
          onChange={(sharedInstructions) => setPolicies({ sharedInstructions })}
        />
        {nodeIssues.map((issue) => (
          <InspectorNote
            key={issue.code + issue.message}
            tone={issue.severity === 'error' ? 'error' : 'warning'}
          >
            {issue.message}
          </InspectorNote>
        ))}
      </InspectorSection>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.WorkflowSettingsInspector.72fa09e7ed',
          'Execution policy'
        )}
      >
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.63d88f5d39',
            'Agents at once'
          )}
          min={1}
          max={16}
          value={policies.maxConcurrentAgents}
          onChange={(value) =>
            setPolicies({ maxConcurrentAgents: Math.min(16, Math.max(1, value ?? 1)) })
          }
        />
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.ed1e975c3d',
            'When a task fails'
          )}
          value={policies.failurePolicy}
          description={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.ed131f4cf5',
            'A failure that leaves by an explicit failed-outcome branch never ends the run.'
          )}
          options={[
            {
              value: 'fail-fast',
              label: translate(
                'auto.components.workflows.inspector.WorkflowSettingsInspector.2b7ee58144',
                'Stop the run'
              )
            },
            {
              value: 'continue',
              label: translate(
                'auto.components.workflows.inspector.WorkflowSettingsInspector.b9bb56d96d',
                'Let other branches finish, then fail'
              )
            }
          ]}
          onChange={(failurePolicy) => setPolicies({ failurePolicy })}
        />
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.bf2bfd3ff9',
            'Maximum run duration'
          )}
          suffix="minutes"
          min={1}
          placeholder={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.c105709fa8',
            'None'
          )}
          description={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.369b8f336a',
            'Recorded as a warning when exceeded; Orca does not stop workers on this limit.'
          )}
          value={
            policies.maxRunDurationMs === null
              ? null
              : Math.round(policies.maxRunDurationMs / 60_000)
          }
          onChange={(minutes) =>
            setPolicies({
              maxRunDurationMs: minutes === null ? null : Math.max(1, minutes) * 60_000
            })
          }
        />
      </InspectorSection>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.WorkflowSettingsInspector.8b0fea9fe9',
          'Communication budget'
        )}
      >
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.949fe9f012',
            'Messages per run'
          )}
          min={1}
          max={10_000}
          value={policies.maxTotalMessages}
          onChange={(value) => setPolicies({ maxTotalMessages: value ?? 1 })}
        />
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.46079242a1',
            'Payload bytes per run'
          )}
          min={1_024}
          max={50_000_000}
          value={policies.maxTotalPayloadBytes}
          onChange={(value) => setPolicies({ maxTotalPayloadBytes: value ?? 1_024 })}
        />
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.7480d5e7af',
            'Estimated token budget'
          )}
          min={100}
          placeholder={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.c105709fa8',
            'None'
          )}
          description={translate(
            'auto.components.workflows.inspector.WorkflowSettingsInspector.c653136b10',
            'Estimated at 4 bytes per token across delivered payloads; not provider-measured usage.'
          )}
          value={policies.estimatedTokenBudget}
          onChange={(estimatedTokenBudget) => setPolicies({ estimatedTokenBudget })}
        />
      </InspectorSection>
    </>
  )
}
