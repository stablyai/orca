import type { WorkflowNode } from '../../../../../shared/workflow/workflow-definition-schema'
import React from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  WORKFLOW_BUDGET_ACTIONS,
  WORKFLOW_MESSAGE_TYPES,
  WORKFLOW_PAYLOAD_KINDS,
  type WorkflowBudgetAction,
  type WorkflowCommunicationEdge,
  type WorkflowCommunicationPolicy,
  type WorkflowMessageType,
  type WorkflowPayloadKind
} from '../../../../../shared/workflow/workflow-communication-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import {
  InspectorField,
  InspectorNote,
  InspectorSection,
  NumberField,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField
} from './workflow-inspector-fields'
import { translate } from '@/i18n/i18n'

const NO_NODES: readonly WorkflowNode[] = []

export const PAYLOAD_LABEL: Record<WorkflowPayloadKind, string> = {
  'task-spec': 'Task specification (recipient’s entry)',
  'structured-json': 'Structured JSON result',
  summary: 'Summary of the report',
  'selected-fields': 'Selected result fields',
  'git-diff-ref': 'Git change reference',
  'artifact-refs': 'Artifact references',
  'test-summary': 'Test results',
  'selected-context': 'Fixed context you write',
  'full-transcript': 'Full worker report'
}

const PAYLOAD_HELP: Record<WorkflowPayloadKind, string> = {
  'task-spec':
    'Sends tasks.<recipient id> from the sender’s JSON result, or its summary when absent.',
  'structured-json': 'Sends the sender’s whole WORKFLOW_RESULT object.',
  summary: 'Sends the prose summary from the sender’s worker_done report.',
  'selected-fields': 'Sends only the listed top-level fields of the sender’s result.',
  'git-diff-ref': 'Sends the sender’s worktree id and modified files, not the diff itself.',
  'artifact-refs': 'Sends report path, modified files and any artifacts list.',
  'test-summary': 'Sends the tests field of the result, or the summary when absent.',
  'selected-context': 'Sends exactly the text below; nothing from the sender.',
  'full-transcript':
    'Orca holds the worker’s report, not the provider transcript; the full report is sent.'
}

const TYPE_LABEL: Record<WorkflowMessageType, string> = {
  'task-assignment': 'Task assignment',
  'status-update': 'Status update',
  question: 'Question',
  reply: 'Reply',
  artifact: 'Artifact',
  completion: 'Completion',
  failure: 'Failure',
  'review-feedback': 'Review feedback',
  control: 'Control'
}

const BUDGET_LABEL: Record<WorkflowBudgetAction, string> = {
  reject: 'Reject the message',
  truncate: 'Truncate text payloads',
  'request-shorter': 'Reject and ask for a shorter one',
  escalate: 'Hold for your review',
  'fail-task': 'Fail the task'
}

export function CommunicationInspector({
  edge
}: {
  edge: WorkflowCommunicationEdge
}): React.JSX.Element {
  const commit = useWorkflowEditorStore((state) => state.commit)
  const checkpoint = useWorkflowEditorStore((state) => state.checkpoint)
  const readOnly = useWorkflowEditorStore((state) => state.mode === 'execution')
  const nodes = useWorkflowEditorStore((state) => state.preset?.definition.nodes ?? NO_NODES)
  const update = (mutate: (draft: WorkflowCommunicationEdge) => void): void =>
    commit(
      (draft) => {
        const target = draft.definition.communication.find((candidate) => candidate.id === edge.id)
        if (target) {
          mutate(target)
        }
      },
      { history: false }
    )
  const policy = (patch: Partial<WorkflowCommunicationPolicy>): void =>
    update((draft) => {
      draft.policy = { ...draft.policy, ...patch }
    })
  const label = (id: string): string => nodes.find((node) => node.id === id)?.label ?? id
  const payload = edge.policy.payload

  return (
    <>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.CommunicationInspector.0336b8b8fe',
          'Route'
        )}
      >
        <p className="text-[13px]">
          <span className="font-medium">{label(edge.source)}</span>
          <span className="text-muted-foreground">
            {' '}
            {translate(
              'auto.components.workflows.inspector.CommunicationInspector.a2287bc7ae',
              'may send to'
            )}
          </span>
          <span className="font-medium">{label(edge.target)}</span>
        </p>
        <TextField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.81209b1037',
            'Name'
          )}
          value={edge.name}
          onChange={(name) =>
            update((draft) => {
              draft.name = name.slice(0, 80)
            })
          }
        />
        <SwitchField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.08be3ad9b9',
            'Enabled'
          )}
          description={translate(
            'auto.components.workflows.inspector.CommunicationInspector.b3b102669a',
            'A disabled route grants nothing; Orca refuses messages on it.'
          )}
          checked={edge.enabled}
          onChange={(enabled) =>
            update((draft) => {
              draft.enabled = enabled
            })
          }
        />
        <InspectorField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.7c0c1c9942',
            'Allowed message types'
          )}
        >
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {WORKFLOW_MESSAGE_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={edge.policy.allowedMessageTypes.includes(type)}
                  disabled={readOnly}
                  onCheckedChange={(checked) => {
                    checkpoint()
                    const next =
                      checked === true
                        ? [...edge.policy.allowedMessageTypes, type]
                        : edge.policy.allowedMessageTypes.filter((entry) => entry !== type)
                    if (next.length > 0) {
                      policy({ allowedMessageTypes: next })
                    }
                  }}
                />
                {TYPE_LABEL[type]}
              </label>
            ))}
          </div>
        </InspectorField>
      </InspectorSection>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.CommunicationInspector.2f07797937',
          'Payload'
        )}
      >
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.cc9259a644',
            'What travels on this route'
          )}
          value={payload.kind}
          description={PAYLOAD_HELP[payload.kind]}
          options={WORKFLOW_PAYLOAD_KINDS.map((kind) => ({
            value: kind,
            label: PAYLOAD_LABEL[kind]
          }))}
          onChange={(kind) => policy({ payload: { ...payload, kind } })}
        />
        {payload.kind === 'selected-fields' ? (
          <TextField
            label={translate(
              'auto.components.workflows.inspector.CommunicationInspector.98bd18ea55',
              'Fields'
            )}
            mono
            placeholder={translate(
              'auto.components.workflows.inspector.CommunicationInspector.6a3e11ce6f',
              'verdict, findings'
            )}
            value={payload.fields.join(', ')}
            onChange={(value) =>
              policy({
                payload: {
                  ...payload,
                  fields: value
                    .split(',')
                    .map((field) => field.trim())
                    .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
                }
              })
            }
          />
        ) : null}
        {payload.kind === 'selected-context' ? (
          <TextAreaField
            label={translate(
              'auto.components.workflows.inspector.CommunicationInspector.093f380628',
              'Context to send'
            )}
            rows={4}
            value={payload.context}
            onChange={(context) => policy({ payload: { ...payload, context } })}
          />
        ) : null}
        {payload.kind === 'full-transcript' ? (
          <SwitchField
            label={translate(
              'auto.components.workflows.inspector.CommunicationInspector.1c9b9feab9',
              'I want the full report sent'
            )}
            description={translate(
              'auto.components.workflows.inspector.CommunicationInspector.abf738c4a7',
              'Required for this payload. Large reports may hit this route’s size limit.'
            )}
            checked={payload.transcriptExplicitlyEnabled}
            onChange={(on) => policy({ payload: { ...payload, transcriptExplicitlyEnabled: on } })}
          />
        ) : null}
        <TextField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.e7aa8674ad',
            'Required JSON fields'
          )}
          mono
          placeholder={translate(
            'auto.components.workflows.inspector.CommunicationInspector.5777811a1d',
            'none'
          )}
          description={translate(
            'auto.components.workflows.inspector.CommunicationInspector.2837f3122c',
            'Structured payloads missing these are refused before delivery.'
          )}
          value={edge.policy.requiredPayloadFields.join(', ')}
          onChange={(value) =>
            policy({
              requiredPayloadFields: value
                .split(',')
                .map((field) => field.trim())
                .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
            })
          }
        />
        <InspectorNote>
          {translate(
            'auto.components.workflows.inspector.CommunicationInspector.3abb747eb4',
            'The sender’s conversation is never forwarded. Only what this policy selects from its final report travels.'
          )}
        </InspectorNote>
      </InspectorSection>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.CommunicationInspector.3d51050374',
          'Limits and delivery'
        )}
      >
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.16e306dff5',
            'Maximum message size'
          )}
          suffix="bytes"
          min={64}
          max={5_000_000}
          value={edge.policy.maxMessageBytes}
          onChange={(value) => policy({ maxMessageBytes: value ?? 64_000 })}
        />
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.1b11f3cd8d',
            'Messages per run'
          )}
          min={1}
          max={10_000}
          value={edge.policy.maxMessagesPerRun}
          onChange={(value) => policy({ maxMessagesPerRun: value ?? 1 })}
        />
        <NumberField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.64d7609d8b',
            'Rate limit'
          )}
          suffix="per minute"
          min={1}
          max={600}
          placeholder={translate(
            'auto.components.workflows.inspector.CommunicationInspector.fb300a6b8f',
            'None'
          )}
          value={edge.policy.rateLimitPerMinute}
          onChange={(value) => policy({ rateLimitPerMinute: value })}
        />
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.d13f236e0a',
            'When a limit is hit'
          )}
          value={edge.policy.onBudgetExhausted}
          options={WORKFLOW_BUDGET_ACTIONS.map((action) => ({
            value: action,
            label: BUDGET_LABEL[action]
          }))}
          onChange={(onBudgetExhausted) => policy({ onBudgetExhausted })}
        />
        <SwitchField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.3569cd43a3',
            'Require approval'
          )}
          description={translate(
            'auto.components.workflows.inspector.CommunicationInspector.d18287f149',
            'Hold every message on this route until you release or drop it.'
          )}
          checked={edge.policy.requiresApproval}
          onChange={(requiresApproval) => policy({ requiresApproval })}
        />
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.CommunicationInspector.2b98504f8f',
            'Logging'
          )}
          value={edge.policy.logging}
          options={[
            {
              value: 'full',
              label: translate(
                'auto.components.workflows.inspector.CommunicationInspector.f77c7e15d3',
                'Keep payloads'
              )
            },
            {
              value: 'metadata',
              label: translate(
                'auto.components.workflows.inspector.CommunicationInspector.c679cb44d4',
                'Metadata only for refused messages'
              )
            }
          ]}
          onChange={(logging) => policy({ logging })}
        />
        <InspectorNote>
          {translate(
            'auto.components.workflows.inspector.CommunicationInspector.58b1d597d7',
            'Orca checks every message a workflow agent sends through orchestration against these rules before writing it. A worker’s own send cannot be truncated or parked, so those limits refuse it with guidance instead. Agents with unrestricted shells can still reach the network or files outside Orca; that needs OS-level sandboxing.'
          )}
        </InspectorNote>
      </InspectorSection>
    </>
  )
}
