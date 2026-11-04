import { checkAgentLaunchModelPreferences } from '../agent-launch-model-preferences'
import { isTuiAgent } from '../tui-agent-config'
import {
  isWorkflowAgentNode,
  type WorkflowAgentNode,
  type WorkflowDefinition
} from './workflow-definition-schema'
import type { WorkflowCondition } from './workflow-condition-schema'
import { indexWorkflowExecution } from './workflow-graph-structure'
import type { WorkflowHostCapabilities, WorkflowValidationIssue } from './workflow-validation-types'

function push(
  issues: WorkflowValidationIssue[],
  severity: WorkflowValidationIssue['severity'],
  code: string,
  message: string,
  nodeId: string
): void {
  issues.push({ severity, code, message, nodeId, edgeId: null })
}

/** Refusal text matches `orchestration worker-start`, so the builder never promises a launch Orca refuses. */
export function workflowModelRefusal(
  node: WorkflowAgentNode,
  openCodeModelLaunchSupported: boolean
): string | null {
  const runtime = node.agent.runtime
  if (!isTuiAgent(runtime.agent)) {
    return `${runtime.agent} is not an Orca-supported CLI agent.`
  }
  const checked = checkAgentLaunchModelPreferences({
    agent: runtime.agent,
    openCodeModelLaunchSupported,
    createsWorktree: node.agent.placement.worktree !== 'current',
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {})
  })
  return 'refusal' in checked ? checked.refusal.message : null
}

function conditionReadsFields(condition: WorkflowCondition | null): boolean {
  if (!condition) {
    return false
  }
  switch (condition.kind) {
    case 'field':
      return true
    case 'all':
    case 'any':
      return condition.conditions.some(conditionReadsFields)
    case 'not':
      return conditionReadsFields(condition.condition)
    case 'always':
    case 'outcome':
    case 'approval':
      return false
  }
}

function validateDecisionSubjects(
  definition: WorkflowDefinition,
  issues: WorkflowValidationIssue[]
): void {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const index = indexWorkflowExecution(definition)
  for (const node of definition.nodes) {
    if (node.kind !== 'decision') {
      continue
    }
    const subjectId = node.subjectNodeId ?? index.incoming.get(node.id)?.[0]?.source ?? null
    const subject = subjectId ? nodes.get(subjectId) : undefined
    if (node.subjectNodeId && !subject) {
      push(
        issues,
        'error',
        'decision_subject_missing',
        'The node this decision reads no longer exists.',
        node.id
      )
      continue
    }
    const branches = definition.dependencies.filter((edge) => edge.source === node.id)
    if (
      subject &&
      isWorkflowAgentNode(subject) &&
      subject.agent.prompt.outputFormat !== 'json' &&
      branches.some((edge) => conditionReadsFields(edge.condition))
    ) {
      push(
        issues,
        'error',
        'decision_needs_json',
        `${subject.label} must return a JSON result for this decision to read its fields.`,
        node.id
      )
    }
  }
}

export function validateWorkflowAgentNodes(
  definition: WorkflowDefinition,
  capabilities: WorkflowHostCapabilities | null,
  issues: WorkflowValidationIssue[]
): void {
  for (const node of definition.nodes) {
    if (!isWorkflowAgentNode(node)) {
      continue
    }
    const refusal = workflowModelRefusal(node, capabilities?.openCodeModelLaunchSupported ?? true)
    if (refusal) {
      push(
        issues,
        node.agent.runtime.allowModelFallback ? 'warning' : 'error',
        'model_unsupported',
        node.agent.runtime.allowModelFallback
          ? `${refusal} The agent's own configured model will run instead.`
          : refusal,
        node.id
      )
    }
    const detected = capabilities?.detectedAgents
    if (detected && !detected.includes(node.agent.runtime.agent)) {
      push(
        issues,
        'error',
        'agent_not_detected',
        `${node.agent.runtime.agent} was not found on the execution host. Install it or pick another agent.`,
        node.id
      )
    }
    const installed = capabilities?.installedSkills
    for (const skill of node.agent.skills) {
      if (installed && !installed.includes(skill.name)) {
        push(
          issues,
          skill.required ? 'error' : 'warning',
          'skill_missing',
          `Skill ${skill.name} is not installed on the execution host.`,
          node.id
        )
      }
    }
    if (!node.agent.prompt.roleInstructions.trim() && !node.agent.prompt.taskTemplate.trim()) {
      push(
        issues,
        'error',
        'prompt_empty',
        `${node.label} has no role or task instructions.`,
        node.id
      )
    }
  }
  validateDecisionSubjects(definition, issues)
}
