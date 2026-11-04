import type { WorkflowPreset } from './workflow-definition-schema'
import {
  agentNode,
  buildWorkflowTemplate,
  chain,
  dependency,
  endNode,
  joinNode,
  parallelNode,
  REVIEW_JSON_FIELDS,
  route,
  startNode,
  VERDICT_APPROVED
} from './workflow-template-builders'
import {
  parallelDevelopmentTemplate,
  researchImplementationTemplate,
  sequentialDevelopmentTemplate
} from './workflow-templates-development'

export function hierarchicalTeamTemplate(): WorkflowPreset {
  const specialists = ['api', 'data', 'docs'] as const
  const labels = { api: 'API Specialist', data: 'Data Specialist', docs: 'Docs Specialist' }
  return buildWorkflowTemplate({
    id: 'template-hierarchical-team',
    name: 'Hierarchical Team',
    description:
      'A coordinator plans, three specialists work in parallel, the coordinator synthesizes, and a reviewer signs off.',
    objective: 'Describe work that spans several specialties.',
    nodes: [
      startNode(),
      agentNode('coordinator', 'plan', 'Coordinator: plan', {
        role: 'Coordinator',
        instructions:
          'You are the coordinator. Assign one focused task to each specialist (api, data, docs). Do not write code.',
        jsonFields: ['tasks']
      }),
      parallelNode('split'),
      ...specialists.map((id) =>
        agentNode('agent', id, labels[id], {
          role: labels[id],
          instructions: `You are the ${labels[id].toLowerCase()}. Complete only your assigned task.`
        })
      ),
      joinNode('join'),
      agentNode('coordinator', 'synthesize', 'Coordinator: synthesize', {
        role: 'Coordinator',
        instructions:
          'You are the coordinator. Reconcile the specialists’ results into one consistent change and note any gaps.'
      }),
      agentNode('reviewer', 'reviewer', 'Reviewer', {
        role: 'Reviewer',
        agent: 'codex',
        instructions: 'You are the reviewer. Review the synthesized change. Do not edit code.',
        jsonFields: REVIEW_JSON_FIELDS
      }),
      endNode()
    ],
    dependencies: [
      ...chain('start', 'plan', 'split'),
      ...specialists.flatMap((id) => [dependency('split', id), dependency(id, 'join')]),
      ...chain('join', 'synthesize', 'reviewer', 'end')
    ],
    communication: [
      ...specialists.map((id) => route('plan', id, `${labels[id]} task`, 'task-spec')),
      ...specialists.map((id) => route(id, 'synthesize', `${labels[id]} result`, 'summary')),
      route('synthesize', 'reviewer', 'Synthesis', 'summary')
    ]
  })
}

export function minimalCommunicationTemplate(): WorkflowPreset {
  const workers = ['worker-1', 'worker-2', 'worker-3']
  return buildWorkflowTemplate({
    id: 'template-minimal-communication',
    name: 'Minimal Communication',
    description:
      'Independent workers that never talk to each other send short summaries (2 KB, truncated) to one aggregator.',
    objective: 'Describe a task that splits into independent parts.',
    nodes: [
      startNode(),
      parallelNode('split'),
      ...workers.map((id, index) =>
        agentNode('agent', id, `Worker ${index + 1}`, {
          role: 'Independent worker',
          instructions: `You are independent worker ${index + 1}. Work alone on part ${index + 1} of the objective and report a short summary.`
        })
      ),
      joinNode('join'),
      agentNode('coordinator', 'aggregator', 'Aggregator', {
        role: 'Aggregator',
        instructions:
          'You are the aggregator. Combine the workers’ summaries into one result. You receive summaries only.'
      }),
      endNode()
    ],
    dependencies: [
      dependency('start', 'split'),
      ...workers.flatMap((id) => [dependency('split', id), dependency(id, 'join')]),
      ...chain('join', 'aggregator', 'end')
    ],
    communication: workers.map((id) =>
      route(id, 'aggregator', 'Summary', 'summary', {
        maxMessageBytes: 2_000,
        maxMessagesPerRun: 3,
        onBudgetExhausted: 'truncate',
        allowedMessageTypes: ['completion']
      })
    ),
    policies: { maxTotalMessages: 12 }
  })
}

/** The end-to-end example: Claude plans and builds UI, Codex builds the API and reviews both. */
export function authenticationFeatureTemplate(): WorkflowPreset {
  return buildWorkflowTemplate({
    id: 'template-authentication-feature',
    name: 'Authentication Feature',
    description:
      'Coordinator (Claude) plans; Backend (Codex) and Frontend (Claude) build in parallel without talking to each other; Reviewer (Codex) approves or sends findings back to the Coordinator for up to two revisions.',
    objective:
      'Build a user authentication feature: registration, login, and logout endpoints with password hashing, plus login and registration screens.',
    nodes: [
      startNode(),
      agentNode('coordinator', 'coordinator', 'Coordinator', {
        role: 'Coordinator',
        agent: 'claude',
        instructions:
          'You are the coordinator. Break the objective into a backend task and a frontend task that share one API contract. If you receive review findings, revise both tasks to address them. Do not write code.',
        jsonFields: ['tasks', 'apiContract'],
        outputs: ['tasks.backend', 'tasks.frontend', 'apiContract']
      }),
      parallelNode('split'),
      agentNode('agent', 'backend', 'Backend Implementer', {
        role: 'Backend implementer',
        agent: 'codex',
        instructions:
          'You are the backend implementation agent. Implement the authentication endpoints and their tests only. Do not modify the shared API contract.',
        outputs: ['Code changes', 'Tests', 'API contract as implemented'],
        worktree: 'new-child'
      }),
      agentNode('agent', 'frontend', 'Frontend Implementer', {
        role: 'Frontend implementer',
        agent: 'claude',
        instructions:
          'You are the frontend implementation agent. Implement the login and registration screens against the agreed API contract only.',
        outputs: ['UI changes', 'Test results'],
        worktree: 'new-child'
      }),
      joinNode('join'),
      agentNode('reviewer', 'reviewer', 'Reviewer', {
        role: 'Reviewer',
        agent: 'codex',
        instructions:
          'You are the reviewer. Review both implementations and their evidence against the API contract. Do not edit code. Approve only if both are correct and tested.',
        jsonFields: REVIEW_JSON_FIELDS
      }),
      { id: 'decision', label: 'Approved?', kind: 'decision', subjectNodeId: 'reviewer' },
      endNode()
    ],
    dependencies: [
      ...chain('start', 'coordinator', 'split'),
      dependency('split', 'backend'),
      dependency('split', 'frontend'),
      dependency('backend', 'join'),
      dependency('frontend', 'join'),
      ...chain('join', 'reviewer', 'decision'),
      dependency('decision', 'end', { label: 'approved', condition: VERDICT_APPROVED }),
      dependency('decision', 'coordinator', {
        label: 'revise',
        condition: { kind: 'not', condition: VERDICT_APPROVED },
        loop: 2
      })
    ],
    communication: [
      route('coordinator', 'backend', 'Backend task', 'task-spec', {
        allowedMessageTypes: ['task-assignment']
      }),
      route('coordinator', 'frontend', 'Frontend task', 'task-spec', {
        allowedMessageTypes: ['task-assignment']
      }),
      route('backend', 'reviewer', 'Backend result', 'summary', {
        allowedMessageTypes: ['completion', 'artifact']
      }),
      route('frontend', 'reviewer', 'Frontend result', 'summary', {
        allowedMessageTypes: ['completion', 'artifact']
      }),
      route('reviewer', 'coordinator', 'Review result', 'selected-fields', {
        fields: ['verdict', 'findings'],
        allowedMessageTypes: ['review-feedback']
      })
    ]
  })
}

export function workflowTemplates(): WorkflowPreset[] {
  return [
    sequentialDevelopmentTemplate(),
    parallelDevelopmentTemplate(),
    researchImplementationTemplate(),
    hierarchicalTeamTemplate(),
    minimalCommunicationTemplate(),
    authenticationFeatureTemplate()
  ]
}
