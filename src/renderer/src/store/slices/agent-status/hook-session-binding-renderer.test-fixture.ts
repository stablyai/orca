import { expect } from 'vitest'
import type { HookSessionBindingRendererFixture } from '../../../../../shared/agent-hook-session-binding.test-fixture'
import { getAgentResumeArgv } from '../../../../../shared/agent-session-resume'
import { resumeRecordFromStatus } from '../../../../../shared/agent-resume-record-from-status'
import { createTestStore, makeTab } from '../store-test-helpers'
import { isInheritedFromActivePane } from '../../../hooks/ipc-events/agent-status-routing'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

export const expectReturnedRenderer: HookSessionBindingRendererFixture['expectReturnedRenderer'] = (
  data,
  id,
  agent,
  paneKey,
  worktreeId
) => {
  // Both renderer admission paths consume the actual main-window publication over a foreign live row.
  const store = createTestStore()
  const tab = makeTab({ id: 'tab-1', worktreeId: worktreeId })
  store.setState({ tabsByWorktree: { [worktreeId]: [tab] } })
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { agentType: 'codex', state: 'working', prompt: 'review' },
      undefined,
      {
        updatedAt: data.receivedAt - 1
      }
    )
  expect(
    isInheritedFromActivePane(store.getState().agentStatusByPaneKey[paneKey], data, agent, {
      connectionId: data.connectionId,
      worktreeId: data.worktreeId
    })
  ).toBe(false)
  store
    .getState()
    .setAgentStatus(
      paneKey,
      data,
      undefined,
      { updatedAt: data.receivedAt },
      { connectionId: data.connectionId, worktreeId: data.worktreeId },
      { providerSession: data.providerSession, paneOwner: data.paneOwner }
    )
  const entry = store.getState().agentStatusByPaneKey[paneKey]
  expect(entry).toMatchObject({ agentType: agent, providerSession: { id } })
  const record = resumeRecordFromStatus({
    entry,
    worktreeId: worktreeId,
    capturedAt: data.receivedAt
  })
  expect(record?.providerSession.id).toBe(id)
  if (!record) {
    throw new Error('No actual renderer resume record')
  }
  expect(getAgentResumeArgv(agent, record.providerSession)).toEqual(
    agent === 'hermes' ? ['hermes', '--resume', id] : ['agy', '--conversation', id]
  )
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id).toBe(id)
  expect(
    sleepingRecordFromEntry({
      state: store.getState(),
      entry,
      worktreeId: worktreeId,
      capturedAt: data.receivedAt
    })?.providerSession.id
  ).toBe(id)
  return tab
}
