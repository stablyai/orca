import { defineFixture } from '../../component-fixtures/component-fixture'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { taskNoteIdentity, taskObservation } from './agent-task-status'

const now = Date.now()
function card(id: string, overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: `fixture-${id}`,
    ptyId: null,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Example task',
    repoId: 'example',
    worktreeId: 'example-folder',
    tabId: id,
    leafId: null,
    repoName: 'Example project',
    worktreeName: 'Source inventory',
    workspaceKind: 'folder',
    startedAt: now - 600000,
    finishedAt: null,
    stateChangedAt: now - 60000,
    unseen: false,
    ...overrides
  }
}
const snapshot: DashboardSnapshot = {
  generatedAt: now,
  cards: [
    card('question', {
      conversationName: 'Main/AINF',
      bucket: 'attention',
      dotState: 'waiting',
      askSummary: 'Which source should the inventory use?'
    }),
    card('working', { conversationName: 'Task/AINF/SourceReview', agentType: 'claude' }),
    card('waiting', {
      conversationName: 'Wait/AINF/SourceAccess',
      bucket: 'done',
      dotState: 'done',
      unseen: true,
      finishedAt: now - 100000
    }),
    card('response', {
      conversationName: 'Task/AINF/Inventory',
      bucket: 'done',
      dotState: 'done',
      unseen: true,
      finishedAt: now - 120000,
      lastAgentMessage: '<internal_tag>Long raw conversation stays in the detail.</internal_tag>'
    }),
    card('verified', {
      conversationName: 'Done/AINF/VerifiedReview',
      bucket: 'idle',
      dotState: 'done',
      unseen: false,
      finishedAt: now - 150000
    }),
    card('older', {
      conversationName: 'Done/AINF/OldReview',
      bucket: 'done',
      dotState: 'done',
      unseen: true,
      finishedAt: now - 2 * 86400000
    })
  ]
}

function setupNotes(): void {
  const verified = snapshot.cards.find((entry) => entry.tabId === 'verified')
  if (!verified) {
    throw new Error('Missing verified fixture')
  }
  localStorage.setItem(
    `orca:dashboard-task-note:v1:${taskNoteIdentity(verified)}`,
    JSON.stringify({
      status: 'verified',
      title: 'Reviewed inventory',
      summary: 'Sources checked against the inventory.',
      nextStep: 'Select the next task.',
      owner: 'Project owner',
      reviewReference: 'Example review record',
      observation: taskObservation(verified),
      savedAt: now
    })
  )
}

export const desktop = defineFixture({
  setup: setupNotes,
  width: 1200,
  render: () => (
    <AgentKanbanBoard
      snapshot={snapshot}
      containerClassName="h-[900px] w-full"
      onAckAgent={() => {}}
      onRevealAgent={() => {}}
    />
  )
})
export const phone = defineFixture({
  setup: setupNotes,
  width: 390,
  render: () => (
    <AgentKanbanBoard
      snapshot={snapshot}
      containerClassName="h-[844px] w-full"
      onAckAgent={() => {}}
      onRevealAgent={() => {}}
    />
  )
})

export const detailsPhone = defineFixture({
  ...phone,
  interact(frame) {
    const button = Array.from(frame.querySelectorAll('button')).find(
      (element) => element.textContent === 'Task details'
    )
    button?.click()
  }
})
