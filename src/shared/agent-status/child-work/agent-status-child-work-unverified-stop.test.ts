import { expect, it } from 'vitest'
import { createAgentStatusStore } from '../store/agent-status-store'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from './agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'
import { projectAgentChildWorkViews } from './agent-status-child-work-view'

it('a Stop the provider accepts settles a surfaced command whose state was unverified', () => {
  const parent = makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: '/folder', workspaceKind: 'folder' },
    'session-1'
  )
  const store = createAgentStatusStore({ epoch: 'unverified-stop', mode: 'authority' })
  store.applyMutation({ parent: { subject: parent } })
  let identity = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++identity}`
  })
  const reconcile = (evidence: Parameters<typeof reconcileAgentChildWorkEvidence>[0]['evidence']) =>
    reconcileAgentChildWorkEvidence({ store, admission, parent, evidence, provider: 'claude' })
  reconcile([
    {
      type: 'live',
      observedAt: 100,
      child: {
        handle: { idKind: 'task_id', id: 'bash-1', runId: 'toolu_1' },
        kind: 'command',
        residency: 'background',
        state: 'unverifiable',
        description: 'make test',
        stoppable: true
      }
    }
  ])
  const [child] = store.getChildren(parent)
  expect(projectAgentChildWorkViews([child], [])).toMatchObject([
    { kind: 'command', state: 'unverifiable', membership: 'live', stoppable: true }
  ])
  reconcile([
    {
      type: 'stop-acknowledged',
      observedAt: 200,
      childWorkId: child.childWorkId,
      handleId: 'bash-1',
      invocation: child.invocation
    }
  ])
  expect(store.getChildren(parent)).toMatchObject([
    { membership: 'settled', outcome: 'cancelled', outcomeBasis: 'stop-acknowledged' }
  ])
})
