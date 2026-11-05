import type { WorkflowAgentNode, WorkflowPolicies } from './workflow-definition-schema'
import { WORKFLOW_RESULT_MARKER } from './workflow-worker-result'
import { workflowPayloadBytes } from './workflow-payload-policy'
import type { WorkflowAssembledPrompt, WorkflowPromptSectionSource } from './workflow-run-types'

export type WorkflowPromptInput = {
  from: string
  route: string
  payloadKind: string
  payload: string
}

export type WorkflowPromptRoute = { label: string; address: string | null }

export type WorkflowPromptVariables = {
  objective: string
  runId: string
  nodeId: string
  nodeLabel: string
  iteration: number
}

const VARIABLE = /\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/g

/** Replace only known {{variables}}; anything else stays literal so typos are visible. */
export function interpolateWorkflowTemplate(
  template: string,
  variables: WorkflowPromptVariables
): string {
  const values: Record<string, string> = {
    objective: variables.objective,
    'run.id': variables.runId,
    'node.id': variables.nodeId,
    'node.label': variables.nodeLabel,
    iteration: String(variables.iteration + 1)
  }
  return template.replace(VARIABLE, (whole, name: string) => values[name] ?? whole)
}

function bullets(title: string, items: readonly string[]): string {
  const filled = items.map((item) => item.trim()).filter(Boolean)
  return filled.length > 0 ? `${title}:\n${filled.map((item) => `- ${item}`).join('\n')}` : ''
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.trim().length > 0).join('\n\n')
}

function outputContract(node: WorkflowAgentNode): string {
  const prompt = node.agent.prompt
  if (prompt.outputFormat !== 'json') {
    return prompt.outputRequirements
  }
  const fields =
    prompt.requiredOutputFields.length > 0
      ? ` It must include: ${prompt.requiredOutputFields.join(', ')}.`
      : ''
  return joinBlocks([
    prompt.outputRequirements,
    `End your worker_done --body with one final line that starts with ${WORKFLOW_RESULT_MARKER} followed by a single-line JSON object.${fields} The workflow reads only that line for decisions and downstream payloads.`
  ])
}

function controls(
  node: WorkflowAgentNode,
  routes: readonly WorkflowPromptRoute[],
  iteration: number
): string {
  const skills = node.agent.skills.map((skill) => skill.name)
  const expected = node.agent.tools
    .filter((tool) => tool.mode === 'expected')
    .map((tool) => tool.tool)
  const avoid = node.agent.tools.filter((tool) => tool.mode === 'avoid').map((tool) => tool.tool)
  const reachable = routes.filter((route) => route.address)
  return joinBlocks([
    `You are the "${node.label}" step of an Orca workflow${iteration > 0 ? ` (revision ${iteration + 1})` : ''}.`,
    // Orca captures this reply as the step's answer; worker_done carries only a short summary.
    'Write your complete answer or result as a normal reply before you send worker_done. The workflow shows that reply to the user as your answer.',
    skills.length > 0 ? `Use these installed skills where they apply: ${skills.join(', ')}.` : '',
    expected.length > 0 ? `Expected tools: ${expected.join(', ')}.` : '',
    avoid.length > 0 ? `Do not use: ${avoid.join(', ')}.` : '',
    reachable.length > 0
      ? `You may message only these workflow agents, with orchestration send --to <address>: ${reachable.map((route) => `${route.label} (${route.address})`).join(', ')}. Orca rejects messages to any other agent.`
      : 'Do not message other workflow agents; report to the coordinator only.'
  ])
}

/** Everything the workflow controls about a worker's prompt; Orca's preamble and provider prompts are added outside it. */
export function assembleWorkflowPrompt(args: {
  node: WorkflowAgentNode
  policies: WorkflowPolicies
  variables: WorkflowPromptVariables
  inputs: readonly WorkflowPromptInput[]
  routes: readonly WorkflowPromptRoute[]
}): WorkflowAssembledPrompt {
  const { node, variables } = args
  const profile = node.agent
  type Section = { title: string; source: WorkflowPromptSectionSource; text: string }
  const candidates: Section[] = [
    {
      title: 'Role',
      source: 'user-role',
      text: joinBlocks([
        profile.prompt.roleInstructions,
        profile.role ? `Role: ${profile.role}` : '',
        profile.description,
        bullets('Responsibilities', profile.responsibilities),
        bullets('Allowed actions', profile.allowedActions),
        bullets('Forbidden actions', profile.forbiddenActions),
        bullets('Expected outputs', profile.expectedOutputs),
        bullets('Success criteria', profile.successCriteria)
      ])
    },
    {
      title: 'Shared instructions',
      source: 'user-shared',
      text: profile.prompt.includeSharedInstructions ? args.policies.sharedInstructions : ''
    },
    {
      title: 'Task',
      source: 'user-task',
      text: interpolateWorkflowTemplate(profile.prompt.taskTemplate, variables)
    },
    { title: 'Read-only context', source: 'user-context', text: profile.prompt.readOnlyContext },
    {
      title: 'Inputs from upstream agents',
      source: 'workflow-payload',
      text: args.inputs
        .map(
          (input) =>
            `From ${input.from} via ${input.route} (${input.payloadKind}):\n${input.payload}`
        )
        .join('\n\n')
    },
    { title: 'Output requirements', source: 'user-output', text: outputContract(node) },
    {
      title: 'Workflow controls',
      source: 'workflow-controller',
      text: controls(node, args.routes, variables.iteration)
    }
  ]
  const sections = candidates.filter((section) => section.text.trim().length > 0)
  const text = sections
    .map((section) => `=== ${section.title.toUpperCase()} ===\n${section.text}`)
    .join('\n\n')
  return { sections, text, bytes: workflowPayloadBytes(text) }
}
