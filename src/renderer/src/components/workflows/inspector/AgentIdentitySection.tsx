import React from 'react'
import type { WorkflowAgentNode } from '../../../../../shared/workflow/workflow-definition-schema'
import {
  InspectorField,
  InspectorSection,
  ListField,
  TextAreaField,
  TextField
} from './workflow-inspector-fields'
import { useUpdateAgentProfile, useUpdateWorkflowNode } from './use-workflow-node'
import { translate } from '@/i18n/i18n'

export function AgentIdentitySection({ node }: { node: WorkflowAgentNode }): React.JSX.Element {
  const updateNode = useUpdateWorkflowNode(node.id)
  const update = useUpdateAgentProfile(node.id)
  const profile = node.agent
  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.AgentIdentitySection.90dca236a2',
        'Identity and role'
      )}
    >
      <TextField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.3844fdf45a',
          'Display name'
        )}
        value={node.label}
        invalid={node.label.trim().length === 0}
        onChange={(label) =>
          updateNode((draft) => {
            draft.label = label.slice(0, 80)
          })
        }
      />
      <InspectorField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.0093283097',
          'Node id'
        )}
        description={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.2f7217d255',
          'Stable across saves and exports; Orca task titles include it.'
        )}
      >
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {node.id}
        </div>
      </InspectorField>
      <TextField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.9aa0d4c465',
          'Role'
        )}
        value={profile.role}
        placeholder={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.249c8f19a3',
          'Backend implementer'
        )}
        onChange={(role) =>
          update((agent) => {
            agent.role = role
          })
        }
      />
      <TextAreaField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.797373a9ce',
          'Description'
        )}
        value={profile.description}
        rows={2}
        onChange={(description) =>
          update((agent) => {
            agent.description = description
          })
        }
      />
      <ListField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.7d0cc2585d',
          'Responsibilities'
        )}
        value={profile.responsibilities}
        onChange={(value) =>
          update((agent) => {
            agent.responsibilities = value
          })
        }
      />
      <ListField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.22ce734aa0',
          'Allowed actions'
        )}
        value={profile.allowedActions}
        onChange={(value) =>
          update((agent) => {
            agent.allowedActions = value
          })
        }
      />
      <ListField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.ccdae613ac',
          'Forbidden actions'
        )}
        description={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.f28f446f13',
          'One per line. These are instructions to the agent; Orca enforces only routing, placement and timeouts.'
        )}
        value={profile.forbiddenActions}
        onChange={(value) =>
          update((agent) => {
            agent.forbiddenActions = value
          })
        }
      />
      <ListField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.f559717f19',
          'Expected outputs'
        )}
        value={profile.expectedOutputs}
        onChange={(value) =>
          update((agent) => {
            agent.expectedOutputs = value
          })
        }
      />
      <ListField
        label={translate(
          'auto.components.workflows.inspector.AgentIdentitySection.9dd8d3d72b',
          'Success criteria'
        )}
        value={profile.successCriteria}
        onChange={(value) =>
          update((agent) => {
            agent.successCriteria = value
          })
        }
      />
    </InspectorSection>
  )
}
