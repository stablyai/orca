import React, { useMemo } from 'react'
import { isWorkflowAgentNode } from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { useWorkflowRunViewStore } from '../workflow-run-view-store'
import { AgentIdentitySection } from './AgentIdentitySection'
import { AgentRuntimeSection } from './AgentRuntimeSection'
import { AgentPromptSection } from './AgentPromptSection'
import { AgentSkillsSection, AgentToolsSection } from './AgentSkillsToolsSections'
import { ControlNodeInspector } from './ControlNodeInspector'
import { DependencyInspector } from './DependencyInspector'
import { CommunicationInspector } from './CommunicationInspector'
import { WorkflowSettingsInspector } from './WorkflowSettingsInspector'
import { NodeExecutionInspector } from './NodeExecutionInspector'
import { InspectorNote } from './workflow-inspector-fields'
import { translate } from '@/i18n/i18n'

function NodeIssues({ id, kind }: { id: string; kind: 'node' | 'edge' }) {
  const allIssues = useWorkflowEditorStore((state) => state.issues)
  const issues = useMemo(
    () =>
      allIssues.filter((issue) => (kind === 'node' ? issue.nodeId === id : issue.edgeId === id)),
    [allIssues, id, kind]
  )
  if (issues.length === 0) {
    return null
  }
  return (
    <div className="space-y-1.5 border-b border-border p-4">
      {issues.map((issue) => (
        <InspectorNote
          key={issue.code + issue.message}
          tone={issue.severity === 'error' ? 'error' : 'warning'}
        >
          {issue.message}
        </InspectorNote>
      ))}
    </div>
  )
}

/** Node, edge, or workflow settings by selection; execution mode swaps nodes for their run record. */
export function WorkflowInspector(): React.JSX.Element | null {
  const selection = useWorkflowEditorStore((state) => state.selection)
  const definition = useWorkflowEditorStore((state) => state.preset?.definition)
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const run = useWorkflowRunViewStore((state) => state.run)
  if (!definition) {
    return null
  }
  if (selection?.kind === 'nodes' && selection.ids.length === 1) {
    const id = selection.ids[0]
    if (execution && run) {
      return <NodeExecutionInspector run={run} nodeId={id} />
    }
    const node = definition.nodes.find((candidate) => candidate.id === id)
    if (!node) {
      return null
    }
    return (
      <div key={id}>
        <NodeIssues id={id} kind="node" />
        {isWorkflowAgentNode(node) ? (
          <>
            <AgentIdentitySection node={node} />
            <AgentRuntimeSection node={node} />
            <AgentPromptSection node={node} />
            <AgentSkillsSection node={node} />
            <AgentToolsSection node={node} />
          </>
        ) : (
          <ControlNodeInspector node={node} />
        )}
      </div>
    )
  }
  if (selection?.kind === 'nodes' && selection.ids.length > 1) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {selection.ids.length}{' '}
        {translate(
          'auto.components.workflows.inspector.WorkflowInspector.befe7b1022',
          'nodes selected. Copy, duplicate, or delete them together.'
        )}
      </p>
    )
  }
  if (selection?.kind === 'dependency') {
    const edge = definition.dependencies.find((candidate) => candidate.id === selection.id)
    return edge ? (
      <div key={edge.id}>
        <NodeIssues id={edge.id} kind="edge" />
        <DependencyInspector edge={edge} />
      </div>
    ) : null
  }
  if (selection?.kind === 'communication') {
    const edge = definition.communication.find((candidate) => candidate.id === selection.id)
    return edge ? (
      <div key={edge.id}>
        <NodeIssues id={edge.id} kind="edge" />
        <CommunicationInspector edge={edge} />
      </div>
    ) : null
  }
  return <WorkflowSettingsInspector />
}
