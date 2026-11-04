import React, { useState } from 'react'
import {
  WORKFLOW_FIELD_OPERATORS,
  WorkflowConditionSchema,
  type WorkflowCondition,
  type WorkflowFieldOperator
} from '../../../../../shared/workflow/workflow-condition-schema'
import { describeWorkflowCondition } from '../../../../../shared/workflow/workflow-condition-evaluation'
import type {
  WorkflowExecutionDependency,
  WorkflowNode
} from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import {
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

type ConditionMode = 'always' | 'outcome' | 'approval' | 'field' | 'advanced'

function modeOf(condition: WorkflowCondition | null): ConditionMode {
  if (!condition) {
    return 'always'
  }
  if (condition.kind === 'outcome' || condition.kind === 'approval' || condition.kind === 'field') {
    return condition.kind
  }
  return 'advanced'
}

const OPERATOR_LABEL: Record<WorkflowFieldOperator, string> = {
  equals: 'equals',
  'not-equals': 'does not equal',
  contains: 'contains',
  exists: 'is present',
  'not-exists': 'is missing',
  gt: 'is greater than',
  lt: 'is less than'
}

function parseValue(raw: string): string | number | boolean {
  if (raw === 'true' || raw === 'false') {
    return raw === 'true'
  }
  const number = Number(raw)
  return raw.trim() !== '' && Number.isFinite(number) ? number : raw
}

function ConditionEditor({
  condition,
  onChange
}: {
  condition: WorkflowCondition | null
  onChange: (next: WorkflowCondition | null) => void
}) {
  const [advanced, setAdvanced] = useState(() => modeOf(condition) === 'advanced')
  const mode = advanced ? 'advanced' : modeOf(condition)
  const [json, setJson] = useState(() => JSON.stringify(condition ?? { kind: 'always' }, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  return (
    <>
      <SelectField<ConditionMode>
        label={translate(
          'auto.components.workflows.inspector.DependencyInspector.ba8a8620ef',
          'Runs when'
        )}
        value={mode}
        options={[
          {
            value: 'always',
            label: translate(
              'auto.components.workflows.inspector.DependencyInspector.b08f4927c2',
              'The source succeeds'
            )
          },
          {
            value: 'outcome',
            label: translate(
              'auto.components.workflows.inspector.DependencyInspector.1941c49dc7',
              'The source outcome is…'
            )
          },
          {
            value: 'approval',
            label: translate(
              'auto.components.workflows.inspector.DependencyInspector.0f8e219604',
              'The approval is…'
            )
          },
          {
            value: 'field',
            label: translate(
              'auto.components.workflows.inspector.DependencyInspector.e3c32abf7a',
              'A result field matches…'
            )
          },
          {
            value: 'advanced',
            label: translate(
              'auto.components.workflows.inspector.DependencyInspector.45d3c94f18',
              'Advanced condition (JSON)'
            )
          }
        ]}
        onChange={(next) => {
          setAdvanced(next === 'advanced')
          if (next === 'always') {
            onChange(null)
          } else if (next === 'outcome') {
            onChange({ kind: 'outcome', equals: 'failed' })
          } else if (next === 'approval') {
            onChange({ kind: 'approval', equals: 'approved' })
          } else if (next === 'field') {
            onChange({ kind: 'field', path: 'verdict', op: 'equals', value: 'approved' })
          } else {
            setJson(JSON.stringify(condition ?? { kind: 'always' }, null, 2))
          }
        }}
      />
      {!advanced && condition?.kind === 'outcome' ? (
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.DependencyInspector.d8616dbac0',
            'Outcome'
          )}
          value={condition.equals}
          options={[
            {
              value: 'succeeded',
              label: translate(
                'auto.components.workflows.inspector.DependencyInspector.a36d74ccb2',
                'Succeeded'
              )
            },
            {
              value: 'failed',
              label: translate(
                'auto.components.workflows.inspector.DependencyInspector.5282c6d0c7',
                'Failed'
              )
            }
          ]}
          onChange={(equals) => onChange({ kind: 'outcome', equals })}
        />
      ) : null}
      {!advanced && condition?.kind === 'approval' ? (
        <SelectField
          label={translate(
            'auto.components.workflows.inspector.DependencyInspector.ba4a299201',
            'Decision'
          )}
          value={condition.equals}
          options={[
            {
              value: 'approved',
              label: translate(
                'auto.components.workflows.inspector.DependencyInspector.d0d793ff96',
                'Approved'
              )
            },
            {
              value: 'rejected',
              label: translate(
                'auto.components.workflows.inspector.DependencyInspector.d60e419511',
                'Rejected'
              )
            }
          ]}
          onChange={(equals) => onChange({ kind: 'approval', equals })}
        />
      ) : null}
      {!advanced && condition?.kind === 'field' ? (
        <>
          <TextField
            label={translate(
              'auto.components.workflows.inspector.DependencyInspector.240b17dc96',
              'Field'
            )}
            mono
            value={condition.path}
            description={translate(
              'auto.components.workflows.inspector.DependencyInspector.bff1f16795',
              'A dot path into the source’s WORKFLOW_RESULT, such as verdict.'
            )}
            onChange={(path) => onChange({ ...condition, path })}
          />
          <SelectField
            label={translate(
              'auto.components.workflows.inspector.DependencyInspector.673e3ec992',
              'Comparison'
            )}
            value={condition.op}
            options={WORKFLOW_FIELD_OPERATORS.map((op) => ({
              value: op,
              label: OPERATOR_LABEL[op]
            }))}
            onChange={(op) => onChange({ ...condition, op })}
          />
          {condition.op !== 'exists' && condition.op !== 'not-exists' ? (
            <TextField
              label={translate(
                'auto.components.workflows.inspector.DependencyInspector.2691b3b659',
                'Value'
              )}
              mono
              value={String(condition.value ?? '')}
              onChange={(raw) => onChange({ ...condition, value: parseValue(raw) })}
            />
          ) : null}
        </>
      ) : null}
      {mode === 'advanced' ? (
        <>
          <TextAreaField
            label={translate(
              'auto.components.workflows.inspector.DependencyInspector.022dee4b6f',
              'Condition JSON'
            )}
            mono
            rows={6}
            description={translate(
              'auto.components.workflows.inspector.DependencyInspector.917ddd55f8',
              'all, any and not combine outcome, approval and field conditions. No code runs.'
            )}
            value={json}
            onChange={(text) => {
              setJson(text)
              try {
                const parsed = WorkflowConditionSchema.safeParse(JSON.parse(text))
                if (parsed.success) {
                  setJsonError(null)
                  onChange(parsed.data.kind === 'always' ? null : parsed.data)
                } else {
                  setJsonError(parsed.error.issues[0]?.message ?? 'Invalid condition.')
                }
              } catch {
                setJsonError('Not valid JSON yet.')
              }
            }}
          />
          {jsonError ? <InspectorNote tone="error">{jsonError}</InspectorNote> : null}
        </>
      ) : null}
    </>
  )
}

export function DependencyInspector({
  edge
}: {
  edge: WorkflowExecutionDependency
}): React.JSX.Element {
  const commit = useWorkflowEditorStore((state) => state.commit)
  const nodes = useWorkflowEditorStore((state) => state.preset?.definition.nodes ?? NO_NODES)
  const update = (mutate: (draft: WorkflowExecutionDependency) => void): void =>
    commit(
      (draft) => {
        const target = draft.definition.dependencies.find((candidate) => candidate.id === edge.id)
        if (target) {
          mutate(target)
        }
      },
      { history: false }
    )
  const label = (id: string): string => nodes.find((node) => node.id === id)?.label ?? id
  return (
    <>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.DependencyInspector.b94dfbe925',
          'Execution dependency'
        )}
      >
        <p className="text-[13px]">
          <span className="font-medium">{label(edge.source)}</span>
          <span className="text-muted-foreground">
            {' '}
            {translate(
              'auto.components.workflows.inspector.DependencyInspector.c4c8408157',
              'must settle before'
            )}
          </span>
          <span className="font-medium">{label(edge.target)}</span>
          <span className="text-muted-foreground">
            {' '}
            {translate(
              'auto.components.workflows.inspector.DependencyInspector.60051341f2',
              'can start.'
            )}
          </span>
        </p>
        <TextField
          label={translate(
            'auto.components.workflows.inspector.DependencyInspector.b5c6692c9f',
            'Label'
          )}
          value={edge.label}
          placeholder={describeWorkflowCondition(edge.condition)}
          onChange={(value) =>
            update((draft) => {
              draft.label = value.slice(0, 80)
            })
          }
        />
        <ConditionEditor
          condition={edge.condition}
          onChange={(condition) =>
            update((draft) => {
              draft.condition = condition
            })
          }
        />
        <InspectorNote>
          {translate(
            'auto.components.workflows.inspector.DependencyInspector.c0305f511e',
            'Dependencies decide order only. What the target receives is set by communication routes.'
          )}
        </InspectorNote>
      </InspectorSection>
      <InspectorSection
        title={translate(
          'auto.components.workflows.inspector.DependencyInspector.49e0eec8db',
          'Bounded loop'
        )}
        defaultOpen={edge.loop !== null}
      >
        <SwitchField
          label={translate(
            'auto.components.workflows.inspector.DependencyInspector.81f8d4a4ec',
            'Loop back'
          )}
          description={translate(
            'auto.components.workflows.inspector.DependencyInspector.6a0bd12079',
            'Re-run every node between the target and this edge’s source. Needs a condition.'
          )}
          checked={edge.loop !== null}
          onChange={(on) =>
            update((draft) => {
              draft.loop = on ? { maxIterations: 2 } : null
            })
          }
        />
        {edge.loop ? (
          <NumberField
            label={translate(
              'auto.components.workflows.inspector.DependencyInspector.d328bc010d',
              'Maximum revisions'
            )}
            min={1}
            max={10}
            value={edge.loop.maxIterations}
            onChange={(value) =>
              update((draft) => {
                draft.loop = { maxIterations: Math.min(10, Math.max(1, value ?? 1)) }
              })
            }
          />
        ) : null}
      </InspectorSection>
    </>
  )
}
