import React from 'react'
import {
  isWorkflowAgentNode,
  type WorkflowNode
} from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import {
  InspectorNote,
  InspectorSection,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField
} from './workflow-inspector-fields'
import { useUpdateWorkflowNode } from './use-workflow-node'
import { translate } from '@/i18n/i18n'

const NO_NODES: readonly WorkflowNode[] = []

const AUTO_SUBJECT = '__single_input__'

const CONTROL_HELP: Partial<Record<WorkflowNode['kind'], string>> = {
  start: 'Settles as soon as the run starts. Every workflow has exactly one.',
  end: 'The run completes when an End node is reached and no unrouted task failed.',
  parallel: 'Starts every outgoing branch at once, within the workflow’s agent limit.',
  decision:
    'Takes the first outgoing branch whose condition matches, in definition order; an unconditioned branch is the fallback.',
  approval:
    'Creates an Orca decision gate and waits for you to approve or reject in Execution mode.'
}

export function ControlNodeInspector({ node }: { node: WorkflowNode }): React.JSX.Element {
  const update = useUpdateWorkflowNode(node.id)
  const nodes = useWorkflowEditorStore((state) => state.preset?.definition.nodes ?? NO_NODES)
  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.ControlNodeInspector.c4eff18961',
        'Node'
      )}
    >
      <TextField
        label={translate(
          'auto.components.workflows.inspector.ControlNodeInspector.d6dcde094f',
          'Display name'
        )}
        value={node.label}
        onChange={(label) =>
          update((draft) => {
            draft.label = label.slice(0, 80)
          })
        }
      />
      {CONTROL_HELP[node.kind] ? <InspectorNote>{CONTROL_HELP[node.kind]}</InspectorNote> : null}
      {node.kind === 'join' ? (
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.adfcee1ce6',
            'Continue when'
          )}
          value={node.mode}
          description={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.9038e403af',
            'Branches a decision skipped count as settled, so they never block a join.'
          )}
          options={[
            {
              value: 'all',
              label: translate(
                'auto.components.workflows.inspector.ControlNodeInspector.1ad206564a',
                'Every incoming branch has settled'
              )
            },
            {
              value: 'any',
              label: translate(
                'auto.components.workflows.inspector.ControlNodeInspector.757e888256',
                'The first incoming branch arrives'
              )
            }
          ]}
          onChange={(mode) =>
            update((draft) => {
              if (draft.kind === 'join') {
                draft.mode = mode
              }
            })
          }
        />
      ) : null}
      {node.kind === 'decision' ? (
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.32cad913dc',
            'Reads the result of'
          )}
          value={node.subjectNodeId ?? AUTO_SUBJECT}
          options={[
            {
              value: AUTO_SUBJECT,
              label: translate(
                'auto.components.workflows.inspector.ControlNodeInspector.8adad3c6f5',
                'Its single input'
              )
            },
            ...nodes
              .filter(isWorkflowAgentNode)
              .map((candidate) => ({ value: candidate.id, label: candidate.label }))
          ]}
          onChange={(subject) =>
            update((draft) => {
              if (draft.kind === 'decision') {
                draft.subjectNodeId = subject === AUTO_SUBJECT ? null : subject
              }
            })
          }
        />
      ) : null}
      {node.kind === 'approval' ? (
        <TextAreaField
          label={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.30e9c3f885',
            'Question'
          )}
          rows={3}
          value={node.question}
          onChange={(question) =>
            update((draft) => {
              if (draft.kind === 'approval') {
                draft.question = question.slice(0, 2_000)
              }
            })
          }
        />
      ) : null}
      {node.kind === 'end' ? (
        <SwitchField
          label={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.eed8356d07',
            'Collect results'
          )}
          description={translate(
            'auto.components.workflows.inspector.ControlNodeInspector.1291a85ab1',
            'Combine every completed agent’s report into the run’s final output.'
          )}
          checked={node.aggregate}
          onChange={(aggregate) =>
            update((draft) => {
              if (draft.kind === 'end') {
                draft.aggregate = aggregate
              }
            })
          }
        />
      ) : null}
    </InspectorSection>
  )
}
