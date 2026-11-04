import React, { useMemo, useState } from 'react'
import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { assembleWorkflowPrompt } from '../../../../../shared/workflow/workflow-prompt-assembly'
import type { WorkflowAgentNode } from '../../../../../shared/workflow/workflow-definition-schema'
import type { WorkflowAssembledPrompt } from '../../../../../shared/workflow/workflow-run-types'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import {
  InspectorNote,
  InspectorSection,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField
} from './workflow-inspector-fields'
import { useUpdateAgentProfile } from './use-workflow-node'
import { translate } from '@/i18n/i18n'

const SOURCE_LABEL: Record<WorkflowAssembledPrompt['sections'][number]['source'], string> = {
  'user-role': 'Your role instructions',
  'user-shared': 'Workflow shared instructions',
  'user-task': 'Your task template',
  'user-context': 'Your read-only context',
  'user-output': 'Your output requirements',
  'workflow-payload': 'Inbound route payloads',
  'workflow-controller': 'Added by the workflow controller'
}

export function WorkflowPromptSections({
  prompt
}: {
  prompt: WorkflowAssembledPrompt
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {prompt.sections.map((section) => (
        <section key={section.title} className="rounded-md border border-border">
          <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
            <span className="text-xs font-medium">{section.title}</span>
            <span className="text-2xs text-muted-foreground">{SOURCE_LABEL[section.source]}</span>
          </header>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5 scrollbar-sleek">
            {section.text}
          </pre>
        </section>
      ))}
      <InspectorNote>
        {translate(
          'auto.components.workflows.inspector.AgentPromptSection.b836ba3bae',
          'Orca adds its orchestration preamble (Task and Dispatch ids, how to report) when it dispatches the task. The agent CLI and its provider add their own system instructions, which Orca does not see or replace.'
        )}
      </InspectorNote>
    </div>
  )
}

function PromptPreviewDialog({
  node,
  open,
  onOpenChange
}: {
  node: WorkflowAgentNode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const preset = useWorkflowEditorStore((state) => state.preset)
  const prompt = useMemo(() => {
    if (!preset) {
      return null
    }
    const inbound = preset.definition.communication.filter(
      (edge) => edge.enabled && edge.target === node.id
    )
    return assembleWorkflowPrompt({
      node,
      policies: preset.definition.policies,
      variables: {
        objective: preset.defaultRunSettings.objective || '<run objective>',
        runId: '<run id>',
        nodeId: node.id,
        nodeLabel: node.label,
        iteration: 0
      },
      inputs: inbound.map((edge) => ({
        from:
          preset.definition.nodes.find((candidate) => candidate.id === edge.source)?.label ??
          edge.source,
        route: edge.name || edge.id,
        payloadKind: edge.policy.payload.kind,
        payload: `<${edge.policy.payload.kind} from the sender’s report, filled at dispatch>`
      })),
      routes: preset.definition.communication
        .filter((edge) => edge.enabled && edge.source === node.id)
        .map((edge) => ({
          label:
            preset.definition.nodes.find((candidate) => candidate.id === edge.target)?.label ??
            edge.target,
          address: '<dispatch id at run time>'
        }))
    })
  }, [node, preset])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollable className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.workflows.inspector.AgentPromptSection.99179f2c95',
              'Effective prompt ·'
            )}{' '}
            {node.label}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.workflows.inspector.AgentPromptSection.949b18a793',
              'What the workflow sends as this task’s specification. Payloads and peer addresses are placeholders until a run fills them.'
            )}{' '}
            {prompt
              ? translate(
                  'auto.components.workflows.inspector.AgentPromptSection.22b5b076b2',
                  '{{value0}} bytes.',
                  { value0: prompt.bytes }
                )
              : ''}
          </DialogDescription>
        </DialogHeader>
        {prompt ? <WorkflowPromptSections prompt={prompt} /> : null}
      </DialogContent>
    </Dialog>
  )
}

export function AgentPromptSection({ node }: { node: WorkflowAgentNode }): React.JSX.Element {
  const update = useUpdateAgentProfile(node.id)
  const [previewOpen, setPreviewOpen] = useState(false)
  const prompt = node.agent.prompt
  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.AgentPromptSection.0bcb8f14f8',
        'Instructions'
      )}
      aside={
        <Button variant="ghost" size="xs" onClick={() => setPreviewOpen(true)}>
          <Eye />
          {translate(
            'auto.components.workflows.inspector.AgentPromptSection.6482bdf54d',
            'Preview'
          )}
        </Button>
      }
    >
      <TextAreaField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.f85aebe252',
          'Role instructions'
        )}
        rows={5}
        value={prompt.roleInstructions}
        onChange={(value) =>
          update((agent) => {
            agent.prompt.roleInstructions = value
          })
        }
      />
      <TextAreaField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.5fb5a0d3b4',
          'Task template'
        )}
        rows={3}
        description={
          <>
            {translate(
              'auto.components.workflows.inspector.AgentPromptSection.cc7e2e4b37',
              'Variables:'
            )}
            <code className="font-mono">
              {translate(
                'auto.components.workflows.inspector.AgentPromptSection.8d1907e440',
                '{{objective}}'
              )}
            </code>
            ,{' '}
            <code className="font-mono">
              {translate(
                'auto.components.workflows.inspector.AgentPromptSection.69c67b0b76',
                '{{node.label}}'
              )}
            </code>
            ,{' '}
            <code className="font-mono">
              {translate(
                'auto.components.workflows.inspector.AgentPromptSection.61869a7426',
                '{{iteration}}'
              )}
            </code>
            ,{' '}
            <code className="font-mono">
              {translate(
                'auto.components.workflows.inspector.AgentPromptSection.8b9d7e9293',
                '{{run.id}}'
              )}
            </code>
            .
          </>
        }
        value={prompt.taskTemplate}
        onChange={(value) =>
          update((agent) => {
            agent.prompt.taskTemplate = value
          })
        }
      />
      <SwitchField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.fb5945c57a',
          'Include shared instructions'
        )}
        checked={prompt.includeSharedInstructions}
        onChange={(value) =>
          update((agent) => {
            agent.prompt.includeSharedInstructions = value
          })
        }
      />
      <TextAreaField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.1c4204a63a',
          'Read-only context'
        )}
        rows={3}
        description={translate(
          'auto.components.workflows.inspector.AgentPromptSection.8034fd7d0f',
          'Reference material sent verbatim under its own Read-only context heading.'
        )}
        value={prompt.readOnlyContext}
        onChange={(value) =>
          update((agent) => {
            agent.prompt.readOnlyContext = value
          })
        }
      />
      <TextAreaField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.02c9587d3d',
          'Output requirements'
        )}
        rows={3}
        value={prompt.outputRequirements}
        onChange={(value) =>
          update((agent) => {
            agent.prompt.outputRequirements = value
          })
        }
      />
      <SelectField
        label={translate(
          'auto.components.workflows.inspector.AgentPromptSection.395984f7c0',
          'Result format'
        )}
        value={prompt.outputFormat}
        description={translate(
          'auto.components.workflows.inspector.AgentPromptSection.8061aee65d',
          'JSON asks the agent for a WORKFLOW_RESULT object that decisions and routes can read.'
        )}
        options={[
          {
            value: 'text',
            label: translate(
              'auto.components.workflows.inspector.AgentPromptSection.a05dd00a0a',
              'Text summary'
            )
          },
          {
            value: 'json',
            label: translate(
              'auto.components.workflows.inspector.AgentPromptSection.4f7c45f74e',
              'Text summary plus JSON result'
            )
          }
        ]}
        onChange={(outputFormat) =>
          update((agent) => {
            agent.prompt.outputFormat = outputFormat
          })
        }
      />
      {prompt.outputFormat === 'json' ? (
        <TextField
          label={translate(
            'auto.components.workflows.inspector.AgentPromptSection.c4610dbac4',
            'Required result fields'
          )}
          mono
          placeholder={translate(
            'auto.components.workflows.inspector.AgentPromptSection.8168e402b7',
            'verdict, findings'
          )}
          value={prompt.requiredOutputFields.join(', ')}
          onChange={(value) =>
            update((agent) => {
              agent.prompt.requiredOutputFields = value
                .split(',')
                .map((field) => field.trim())
                .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
            })
          }
        />
      ) : null}
      <PromptPreviewDialog node={node} open={previewOpen} onOpenChange={setPreviewOpen} />
    </InspectorSection>
  )
}
