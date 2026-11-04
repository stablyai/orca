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

const REVIEWER_INSTRUCTIONS =
  'You are the reviewer. Inspect the changes and the evidence the implementers reported. Do not edit code. Approve only when the work meets the objective and its tests pass; otherwise list concrete findings.'

const reviewDecision = {
  id: 'decision',
  label: 'Approved?',
  kind: 'decision',
  subjectNodeId: 'reviewer'
} as const

export function sequentialDevelopmentTemplate(): WorkflowPreset {
  return buildWorkflowTemplate({
    id: 'template-sequential-development',
    name: 'Sequential Development',
    description:
      'Planner, then Implementer, then Reviewer; a rejected review sends findings back for up to two revisions.',
    objective: 'Describe the change you want built.',
    nodes: [
      startNode(),
      agentNode('coordinator', 'planner', 'Planner', {
        role: 'Planner',
        instructions:
          'You are the planner. Break the objective into a precise implementation plan. Do not write code.',
        outputs: ['A numbered plan with files to change and tests to add'],
        jsonFields: ['tasks']
      }),
      agentNode('agent', 'implementer', 'Implementer', {
        role: 'Implementer',
        instructions:
          'You are the implementer. Implement the plan you are given and run the relevant tests. Address any review findings you receive.',
        outputs: ['Modified files', 'Test results', 'Unresolved issues'],
        maxAttempts: 2
      }),
      agentNode('reviewer', 'reviewer', 'Reviewer', {
        role: 'Reviewer',
        agent: 'codex',
        instructions: REVIEWER_INSTRUCTIONS,
        jsonFields: REVIEW_JSON_FIELDS,
        outputs: ['verdict: approved or rejected', 'findings: list of concrete issues']
      }),
      reviewDecision,
      endNode()
    ],
    dependencies: [
      ...chain('start', 'planner', 'implementer', 'reviewer', 'decision'),
      dependency('decision', 'end', { label: 'approved', condition: VERDICT_APPROVED }),
      dependency('decision', 'implementer', {
        label: 'revise',
        condition: { kind: 'not', condition: VERDICT_APPROVED },
        loop: 2
      })
    ],
    communication: [
      route('planner', 'implementer', 'Plan', 'task-spec'),
      route('implementer', 'reviewer', 'Implementation report', 'summary'),
      route('reviewer', 'implementer', 'Review findings', 'selected-fields', {
        fields: ['findings'],
        allowedMessageTypes: ['review-feedback']
      })
    ]
  })
}

export function parallelDevelopmentTemplate(): WorkflowPreset {
  return buildWorkflowTemplate({
    id: 'template-parallel-development',
    name: 'Parallel Development',
    description:
      'A coordinator splits work between backend and frontend agents in separate worktrees; a reviewer checks both before integration.',
    objective: 'Describe a feature with backend and frontend parts.',
    nodes: [
      startNode(),
      agentNode('coordinator', 'coordinator', 'Coordinator', {
        role: 'Coordinator',
        instructions:
          'You are the coordinator. Split the objective into a backend task and a frontend task with a shared API contract. Do not write code.',
        jsonFields: ['tasks'],
        outputs: ['tasks.backend and tasks.frontend specifications']
      }),
      parallelNode('split'),
      agentNode('agent', 'backend', 'Backend', {
        role: 'Backend implementer',
        agent: 'codex',
        instructions:
          'You are the backend implementation agent. Implement assigned backend tasks only. Do not modify shared API contracts without approval. Return modified files, test results, and unresolved issues.',
        worktree: 'new-child'
      }),
      agentNode('agent', 'frontend', 'Frontend', {
        role: 'Frontend implementer',
        instructions:
          'You are the frontend implementation agent. Implement assigned UI tasks only and keep to the agreed API contract.',
        worktree: 'new-child'
      }),
      joinNode('join'),
      agentNode('reviewer', 'reviewer', 'Reviewer', {
        role: 'Reviewer',
        agent: 'codex',
        instructions: REVIEWER_INSTRUCTIONS,
        jsonFields: REVIEW_JSON_FIELDS
      }),
      agentNode('agent', 'integration', 'Integration', {
        role: 'Integrator',
        instructions:
          'You are the integrator. Merge the backend and frontend worktrees into this workspace, resolve conflicts, and run the full test suite.'
      }),
      endNode()
    ],
    dependencies: [
      ...chain('start', 'coordinator', 'split'),
      dependency('split', 'backend'),
      dependency('split', 'frontend'),
      dependency('backend', 'join'),
      dependency('frontend', 'join'),
      ...chain('join', 'reviewer', 'integration', 'end')
    ],
    communication: [
      route('coordinator', 'backend', 'Backend task', 'task-spec'),
      route('coordinator', 'frontend', 'Frontend task', 'task-spec'),
      route('backend', 'reviewer', 'Backend report', 'summary'),
      route('frontend', 'reviewer', 'Frontend report', 'summary'),
      route('backend', 'integration', 'Backend changes', 'git-diff-ref'),
      route('frontend', 'integration', 'Frontend changes', 'git-diff-ref'),
      route('reviewer', 'integration', 'Review', 'structured-json')
    ]
  })
}

export function researchImplementationTemplate(): WorkflowPreset {
  return buildWorkflowTemplate({
    id: 'template-research-implementation',
    name: 'Research and Implementation',
    description:
      'Research the problem, design a solution, implement it, then validate it independently.',
    objective: 'Describe the problem to research and solve.',
    nodes: [
      startNode(),
      agentNode('agent', 'researcher', 'Researcher', {
        role: 'Researcher',
        instructions:
          'You are the researcher. Investigate the codebase and constraints relevant to the objective. Do not change files.'
      }),
      agentNode('agent', 'architect', 'Architect', {
        role: 'Architect',
        instructions:
          'You are the architect. Turn the research into a concrete design with interfaces and a test plan. Do not write code.',
        jsonFields: ['design', 'testPlan']
      }),
      agentNode('agent', 'implementer', 'Implementer', {
        role: 'Implementer',
        agent: 'codex',
        instructions:
          'You are the implementer. Build the design exactly as specified and add the planned tests.'
      }),
      agentNode('reviewer', 'validator', 'Validator', {
        role: 'Validator',
        instructions:
          'You are the validator. Run the test plan and verify behaviour end to end. Do not edit code.',
        jsonFields: ['verdict', 'tests']
      }),
      endNode()
    ],
    dependencies: chain('start', 'researcher', 'architect', 'implementer', 'validator', 'end'),
    communication: [
      route('researcher', 'architect', 'Findings', 'summary'),
      route('architect', 'implementer', 'Design', 'structured-json'),
      route('architect', 'validator', 'Test plan', 'selected-fields', { fields: ['testPlan'] }),
      route('implementer', 'validator', 'Changes', 'git-diff-ref')
    ]
  })
}
