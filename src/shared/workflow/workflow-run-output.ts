import { isWorkflowAgentNode } from './workflow-definition-schema'
import { workflowTopologicalOrder } from './workflow-graph-structure'
import { currentWorkflowTask, findWorkflowNode } from './workflow-run-state'
import type { WorkflowRun } from './workflow-run-types'

/** The final output: each agent's latest completed report, in execution order. */
export function aggregateWorkflowOutput(run: WorkflowRun): string {
  const sections: string[] = []
  for (const nodeId of workflowTopologicalOrder(run.definition)) {
    const node = findWorkflowNode(run.definition, nodeId)
    if (!isWorkflowAgentNode(node)) {
      continue
    }
    const task = currentWorkflowTask(run, nodeId)
    if (task.status !== 'completed' || !task.report) {
      continue
    }
    const files =
      task.report.filesModified.length > 0 ? `\nFiles: ${task.report.filesModified.join(', ')}` : ''
    sections.push(`## ${node.label}\n${task.report.subject}\n\n${task.report.summary}${files}`)
  }
  return sections.join('\n\n')
}
