import { describe, expect, it } from 'vitest'
import type { AgentDotState } from '../agent-dot-state'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun, AutomationRunStatus } from '../automations/history/automation-run'
import type { Bot } from '../bot-types'
import {
  buildBotActivity,
  type BotSessionActivityRow,
  type BotWorkerRow
} from './bot-activity-model'
import { botNow } from './bot-now'

const bot: Bot = {
  id: 'bot-1',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'chat',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const worker = (id: string, dot: AgentDotState): BotWorkerRow => ({
  kind: 'worker',
  key: id,
  dispatchId: id,
  title: id,
  dot,
  origin: { kind: 'chat' },
  paneKey: null,
  workspaceId: null,
  at: 1,
  worker: null
})
const thread = (id: string, dot: AgentDotState): BotSessionActivityRow => ({
  kind: 'thread',
  key: id,
  title: id,
  source: 'slack',
  dot,
  sessionId: id,
  at: 1
})

function automation(id: string): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only the fields set here.
  return {
    id,
    name: id,
    enabled: true,
    nextRunAt: 100,
    rrule: 'FREQ=DAILY',
    workspaceId: 'folder:fw-1'
  } as Automation
}

function run(automationId: string, status: AutomationRunStatus, createdAt: number): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only the fields set here.
  return {
    id: `${automationId}-${createdAt}`,
    automationId,
    status,
    chatSessionId: null,
    terminalPaneKey: null,
    createdAt,
    startedAt: createdAt,
    dispatchedAt: createdAt
  } as AutomationRun
}

function activityWith(runs: AutomationRun[]) {
  return buildBotActivity({
    bot,
    sessions: [],
    links: [],
    workers: [],
    automations: [automation('label-bugs'), automation('digest')],
    runs,
    sessionStatus: () => null
  })
}

const linear = [{ key: 'linear:w1' }]

describe('botNow', () => {
  it('counts approvals, questions, access requests and the Home chat as needing the owner, never a failed run', () => {
    const activity = activityWith([run('label-bugs', 'dispatch_failed', 5)])
    expect(
      botNow<never, { requestId: string }>({
        activity: {
          ...activity,
          workers: [worker('w1', 'blocked'), worker('w2', 'working')],
          inProgress: [thread('t1', 'waiting'), thread('t2', 'monitoring')]
        },
        chatState: 'blocked',
        accessRequests: [{ requestId: 'r1' }, { requestId: 'r2' }]
      })
    ).toMatchObject({ needsYou: 5, working: 2 })
  })

  it('counts a side chat waiting on the owner, which no activity row carries', () => {
    const now = botNow({
      activity: activityWith([]),
      chatState: null,
      waitingSideChats: [{ sessionId: 's1', title: 'Draft the release notes' }]
    })
    expect(now.needs).toEqual([
      { kind: 'side-chat', key: 'side-chat:s1', sessionId: 's1', title: 'Draft the release notes' }
    ])
    expect(now.needsYou).toBe(1)
  })

  it('counts a running terminal run and an idle open worker as working, whatever their dot', () => {
    const activity = buildBotActivity({
      bot,
      sessions: [],
      links: [],
      workers: [],
      automations: [automation('digest')],
      runs: [run('digest', 'dispatched', 5)],
      sessionStatus: () => null
    })
    const now = botNow({
      activity: { ...activity, workers: [worker('w1', 'idle')] },
      chatState: null
    })
    expect(now.working).toBe(2)
  })

  it('counts a connector sign-in once, with the runs it stopped listed under it', () => {
    const activity = activityWith([
      run('label-bugs', 'skipped_needs_interactive_auth', 5),
      run('digest', 'skipped_needs_interactive_auth', 6)
    ])
    const now = botNow<{ key: string }>({ activity, chatState: null, connectors: linear })
    expect(now.needs.map((need) => need.key)).toEqual(['connector:linear:w1'])
    expect(now.stoppedForSignIn.map((row) => row.latestRunId)).toEqual(['label-bugs-5', 'digest-6'])
    expect(now.needsYou).toBe(1)
  })

  it('drops a sign-in stop once no connector needs the owner, even before the next run', () => {
    const activity = activityWith([run('label-bugs', 'skipped_needs_interactive_auth', 5)])
    const now = botNow({ activity, chatState: null })
    expect(now.needsYou).toBe(0)
    expect(now.stoppedForSignIn).toEqual([])
  })
})
