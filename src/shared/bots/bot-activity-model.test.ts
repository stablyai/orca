import { structuredAgentSessionStatusPaneKey } from '../agent-session/view/structured-agent-session-tab'
import { describe, expect, it } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../agent-status/contracts/agent-status-types'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun } from '../automations/history/automation-run'
import type { Bot } from '../bot-types'
import type { OrchestrationSessionWorker } from '../orchestration-session-workers'
import {
  BOT_ACTIVITY_COMPLETED_LIMIT,
  buildBotActivity,
  type BotActivityInput,
  type BotWorkerObservation
} from './bot-activity-model'
import { workingWorkerRowCount } from './bot-activity-recorded-workers'
import { botNow } from './bot-now'

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'chat-session',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const sessions = [
  { paneKey: 'tab-home:pane', sessionId: 'chat-session', label: 'Home' },
  { paneKey: 'tab-thread:pane', sessionId: 'thread-session', label: '#eng · review' },
  { paneKey: 'tab-run:pane', sessionId: 'run-session', label: 'Weekly check' },
  { paneKey: 'tab-other:pane', sessionId: 'other-session', label: 'Scratch' }
]

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only the fields set here.
  return {
    id,
    name: `Automation ${id}`,
    enabled: true,
    nextRunAt: 100,
    rrule: 'FREQ=DAILY',
    workspaceId: 'folder:fw-1',
    ...overrides
  } as Automation
}

function run(
  id: string,
  automationId: string,
  overrides: Partial<AutomationRun> = {}
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only the fields set here.
  return {
    id,
    automationId,
    status: 'completed',
    chatSessionId: null,
    createdAt: 10,
    startedAt: 10,
    dispatchedAt: 10,
    ...overrides
  } as AutomationRun
}

function worker(
  paneKey: string,
  orchestration: Partial<AgentStatusOrchestrationContext>,
  entry: Partial<AgentStatusEntry> | null = { state: 'working', stateStartedAt: 5 }
): BotWorkerObservation {
  return {
    paneKey,
    orchestration: { taskId: `task-${paneKey}`, dispatchId: `d-${paneKey}`, ...orchestration },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state, workingMode, prompt and stateStartedAt.
    entry: entry as AgentStatusEntry | null,
    worktreeId: `wt-${paneKey}`
  }
}

function input(overrides: Partial<BotActivityInput>): BotActivityInput {
  return {
    bot,
    sessions,
    links: [],
    workers: [],
    automations: [],
    runs: [],
    sessionStatus: () => null,
    ...overrides
  }
}

describe('buildBotActivity', () => {
  it('stamps each worker with what started it', () => {
    const activity = buildBotActivity(
      input({
        links: [
          {
            source: 'slack',
            externalId: 'T1:C1:1',
            sessionId: 'thread-session',
            paneKey: 'tab-thread:pane',
            agent: 'claude',
            createdAt: 1
          },
          // The Chat's direct-message link does not make it a thread.
          {
            source: 'slack',
            externalId: 'T1:D1',
            sessionId: 'chat-session',
            paneKey: 'tab-home:pane',
            agent: 'claude',
            createdAt: 1
          }
        ],
        automations: [automation('a1', { name: 'Weekly check' })],
        runs: [run('r1', 'a1', { chatSessionId: 'run-session' })],
        workers: [
          worker('w-chat', { parentPaneKey: 'tab-home:pane', taskTitle: 'From chat' }),
          worker('w-thread', { parentPaneKey: 'tab-thread:pane', taskTitle: 'From thread' }),
          worker('w-run', { parentPaneKey: 'tab-run:pane', taskTitle: 'From run' }),
          worker('w-other', { parentPaneKey: 'tab-other:pane', taskTitle: 'From scratch' })
        ]
      })
    )

    const origins = Object.fromEntries(activity.workers.map((row) => [row.title, row.origin]))
    expect(origins).toEqual({
      'From chat': { kind: 'chat' },
      'From thread': { kind: 'thread', source: 'slack' },
      'From run': { kind: 'automation', name: 'Weekly check' },
      'From scratch': { kind: 'session', label: 'Scratch' }
    })
  })

  it('follows a worker a worker started, and an automation run started in a terminal', () => {
    const activity = buildBotActivity(
      input({
        automations: [automation('a1', { name: 'Nightly sweep' })],
        runs: [run('r1', 'a1', { terminalPaneKey: 'run-terminal:pane' })],
        workers: [
          worker('w-parent', { parentPaneKey: 'tab-home:pane', taskTitle: 'Parent' }),
          worker('w-child', { parentPaneKey: 'w-parent', taskTitle: 'Child' }),
          worker('w-run', { parentPaneKey: 'run-terminal:pane', taskTitle: 'From terminal run' }),
          worker('w-loop-a', { parentPaneKey: 'w-loop-b' }),
          worker('w-loop-b', { parentPaneKey: 'w-loop-a' })
        ]
      })
    )

    const origins = Object.fromEntries(activity.workers.map((row) => [row.title, row.origin]))
    expect(origins).toEqual({
      Parent: { kind: 'chat' },
      Child: { kind: 'chat' },
      'From terminal run': { kind: 'automation', name: 'Nightly sweep' }
    })
  })

  it("leaves out workers that none of the bot's sessions started", () => {
    const activity = buildBotActivity(
      input({
        workers: [
          worker('w-elsewhere', { parentPaneKey: 'tab-elsewhere:pane' }),
          worker('w-root', {})
        ]
      })
    )

    expect(activity.workers).toEqual([])
    expect(activity.completed).toEqual([])
  })

  it('moves finished workers to Completed and opens their own workspace', () => {
    const activity = buildBotActivity(
      input({
        workers: [
          worker('w-done', { parentPaneKey: 'tab-home:pane', dispatchStatus: 'completed' }),
          worker('w-failed', { parentPaneKey: 'tab-home:pane', dispatchStatus: 'failed' }),
          worker('w-live', { parentPaneKey: 'tab-home:pane', dispatchStatus: 'dispatched' })
        ]
      })
    )

    expect(activity.workers.map((row) => row.key)).toEqual(['worker:d-w-live'])
    expect(
      activity.completed.map((row) => (row.kind === 'worker' ? [row.key, row.dot] : null))
    ).toEqual([
      ['worker:d-w-done', 'done'],
      ['worker:d-w-failed', 'failed']
    ])
    expect(activity.workers[0]).toMatchObject({ workspaceId: 'wt-w-live' })
  })

  it('adds a bot chat’s own workers, the host’s record winning over the runtime’s view', () => {
    const recorded = (dispatchId: string, state: OrchestrationSessionWorker['state']) => ({
      dispatchId,
      taskId: `task-${dispatchId}`,
      runId: 'run-1',
      title: `Recorded ${dispatchId}`,
      agent: 'claude',
      state,
      liveness: 'live' as const,
      host: 'local' as const,
      worktreeId: 'wt-recorded',
      paneKey: null,
      chatSessionId: `chat-${dispatchId}`,
      startedAt: 50,
      settledAt: state === 'working' ? null : 60
    })
    const activity = buildBotActivity(
      input({
        workers: [worker('w-term', { parentPaneKey: 'tab-home:pane', dispatchId: 'd-shared' })],
        recordedWorkers: [
          {
            worker: recorded('d-shared', 'working'),
            creatorSessionId: 'chat-session',
            creatorPaneKey: null
          },
          {
            worker: recorded('d-chat', 'completed'),
            creatorSessionId: 'chat-session',
            creatorPaneKey: null
          },
          {
            worker: recorded('d-unlinked', 'working'),
            creatorSessionId: 'thread-session',
            creatorPaneKey: null
          },
          {
            worker: recorded('d-stranger', 'working'),
            creatorSessionId: 'elsewhere',
            creatorPaneKey: null
          }
        ]
      })
    )

    expect(activity.workers.map((row) => [row.key, row.title, row.origin])).toEqual([
      ['worker:d-shared', 'Recorded d-shared', { kind: 'chat' }],
      ['worker:d-unlinked', 'Recorded d-unlinked', { kind: 'session', label: '#eng · review' }]
    ])
    expect(activity.completed.map((row) => row.key)).toEqual(['worker:d-chat'])
  })

  it('keeps an open worker up top whatever its agent reports; a settled one is history', () => {
    const terminalWorker = (
      dispatchId: string,
      state: OrchestrationSessionWorker['state'],
      activity?: OrchestrationSessionWorker['activity']
    ): OrchestrationSessionWorker => ({
      dispatchId,
      taskId: `task-${dispatchId}`,
      runId: 'run-1',
      title: dispatchId,
      agent: 'claude',
      state,
      ...(activity ? { activity } : {}),
      liveness: 'live',
      host: 'local',
      worktreeId: null,
      paneKey: `pane-${dispatchId}`,
      chatSessionId: null,
      startedAt: 50,
      settledAt: state === 'working' ? null : 60
    })
    const activity = buildBotActivity(
      input({
        recordedWorkers: [
          terminalWorker('d-idle', 'working', 'done'),
          terminalWorker('d-new', 'working'),
          terminalWorker('d-failed', 'failed')
        ].map((worker) => ({ worker, creatorSessionId: 'chat-session', creatorPaneKey: null }))
      })
    )

    expect(activity.workers.map((row) => row.key).sort()).toEqual(['worker:d-idle', 'worker:d-new'])
    expect(activity.completed.map((row) => row.key)).toEqual(['worker:d-failed'])
  })

  it("counts only working agents as running; a worker's open question is its coordinator's, not the owner's", () => {
    const openWorker = (
      dispatchId: string,
      fields: Partial<OrchestrationSessionWorker>
    ): OrchestrationSessionWorker => ({
      dispatchId,
      taskId: `task-${dispatchId}`,
      runId: 'run-1',
      title: dispatchId,
      agent: 'codex',
      state: 'working',
      liveness: 'live',
      host: 'local',
      worktreeId: null,
      paneKey: `pane-${dispatchId}`,
      chatSessionId: null,
      startedAt: 50,
      settledAt: null,
      ...fields
    })
    const activity = buildBotActivity(
      input({
        recordedWorkers: [
          openWorker('d-busy', { activity: 'working' }),
          openWorker('d-idle', { activity: 'done' }),
          openWorker('d-asks', { activity: 'working', pendingQuestion: true }),
          openWorker('d-asks-unseen', {
            state: 'unverifiable',
            liveness: 'unverifiable',
            activity: 'unknown',
            pendingQuestion: true
          })
        ].map((worker) => ({ worker, creatorSessionId: 'chat-session', creatorPaneKey: null }))
      })
    )
    const dotOf = (key: string) => activity.workers.find((row) => row.key === key)?.dot

    expect(activity.workers).toHaveLength(4)
    expect(workingWorkerRowCount(activity.workers)).toBe(1)
    expect(dotOf('worker:d-asks')).toBe('done')
    expect(dotOf('worker:d-asks-unseen')).toBe('unverifiable')
    // Open lands on the worker's pane, where an `ask` shows no prompt to answer.
    expect(
      botNow({ activity, chatState: null }).needs.filter((need) => need.kind === 'session')
    ).toEqual([])
  })

  it('adds the workers of a run chat that has no tab', () => {
    const activity = buildBotActivity(
      input({
        sessions: [],
        automations: [automation('a1')],
        runs: [run('r1', 'a1', { chatSessionId: 'run-chat' })],
        recordedWorkers: [
          {
            worker: {
              dispatchId: 'd-run',
              taskId: 'task-run',
              runId: 'run-1',
              title: 'From the run',
              agent: 'claude',
              state: 'working' as const,
              liveness: 'live' as const,
              host: 'local' as const,
              worktreeId: null,
              paneKey: null,
              chatSessionId: null,
              startedAt: 50,
              settledAt: null
            },
            creatorSessionId: 'run-chat',
            creatorPaneKey: null
          }
        ]
      })
    )

    expect(activity.workers).toMatchObject([
      { key: 'worker:d-run', origin: { kind: 'automation', name: 'Automation a1' } }
    ])
  })

  it("keeps a terminal run's settled worker, by the pane that created it, after its terminal is gone", () => {
    const activity = buildBotActivity(
      input({
        sessions: [],
        automations: [automation('a1', { name: 'Nightly sweep' })],
        runs: [run('r1', 'a1', { terminalPaneKey: 'tab-run-term:pane' })],
        recordedWorkers: [
          {
            worker: {
              dispatchId: 'd-term',
              taskId: 'task-term',
              runId: 'run-1',
              title: 'Swept',
              agent: 'claude',
              state: 'completed' as const,
              liveness: 'exited' as const,
              host: 'local' as const,
              worktreeId: null,
              paneKey: 'worker-pane',
              chatSessionId: null,
              startedAt: 50,
              settledAt: 60
            },
            creatorSessionId: null,
            creatorPaneKey: 'tab-run-term:pane'
          }
        ]
      })
    )

    expect(activity.completed).toContainEqual(
      expect.objectContaining({
        key: 'worker:d-term',
        origin: { kind: 'automation', name: 'Nightly sweep' }
      })
    )
  })

  it('puts running automation runs in progress and keeps the newest completed ones', () => {
    const runs = [
      run('live', 'a1', { status: 'dispatched', dispatchedAt: 1_000 }),
      ...Array.from({ length: BOT_ACTIVITY_COMPLETED_LIMIT + 5 }, (_, index) =>
        run(`done-${index}`, 'a1', { dispatchedAt: index })
      )
    ]
    const activity = buildBotActivity(input({ automations: [automation('a1')], runs }))

    expect(activity.inProgress.map((row) => row.key)).toEqual(['run:live'])
    expect(activity.completed).toHaveLength(BOT_ACTIVITY_COMPLETED_LIMIT)
    expect(activity.completed[0]?.key).toBe(`run:done-${BOT_ACTIVITY_COMPLETED_LIMIT + 4}`)
  })
  it("lists a thread's chat by its status, without a tab, and leaves direct messages to Home", () => {
    const statuses: Record<string, Partial<AgentStatusEntry>> = {
      [structuredAgentSessionStatusPaneKey('thread-live')]: {
        state: 'blocked',
        prompt: 'Deploy?',
        stateStartedAt: 9
      }
    }
    const link = (sessionId: string) => ({
      source: 'slack' as const,
      externalId: `T1:C1:${sessionId}`,
      paneKey: structuredAgentSessionStatusPaneKey(sessionId),
      sessionId,
      agent: 'claude' as const,
      createdAt: 1
    })
    const activity = buildBotActivity(
      input({
        sessions: [],
        links: [link('thread-live'), link('thread-done'), link('chat-session')],
        sessionStatus: (sessionId) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state, workingMode, prompt and stateStartedAt.
          (statuses[structuredAgentSessionStatusPaneKey(sessionId)] as AgentStatusEntry) ?? null
      })
    )

    expect(activity.inProgress).toMatchObject([
      { kind: 'thread', sessionId: 'thread-live', dot: 'blocked', title: 'Deploy?' }
    ])
    expect(activity.completed).toMatchObject([
      { kind: 'thread', sessionId: 'thread-done', dot: 'done', title: '' }
    ])
  })

  it("titles a thread by its link, then by its chat's prompt", () => {
    const statuses: Record<string, Partial<AgentStatusEntry>> = {
      [structuredAgentSessionStatusPaneKey('linear-done')]: {
        state: 'done',
        prompt: '<issue identifier="ENG-6470">\n<title>Bot replies drop the thread title</title>',
        stateStartedAt: 3
      },
      [structuredAgentSessionStatusPaneKey('slack-done')]: {
        state: 'done',
        prompt: 'A later message',
        stateStartedAt: 2
      }
    }
    const link = (sessionId: string, source: 'slack' | 'linear', title?: string) => ({
      source,
      externalId: sessionId,
      paneKey: structuredAgentSessionStatusPaneKey(sessionId),
      sessionId,
      agent: 'claude' as const,
      ...(title ? { title } : {}),
      createdAt: 1
    })
    const activity = buildBotActivity(
      input({
        sessions: [],
        links: [
          link('linear-done', 'linear'),
          link('slack-done', 'slack', 'Why did the nightly build fail?')
        ],
        sessionStatus: (sessionId) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state, workingMode, prompt and stateStartedAt.
          (statuses[structuredAgentSessionStatusPaneKey(sessionId)] as AgentStatusEntry) ?? null
      })
    )

    expect(activity.completed).toMatchObject([
      { kind: 'thread', title: 'ENG-6470 · Bot replies drop the thread title' },
      { kind: 'thread', title: 'Why did the nightly build fail?' }
    ])
  })

  it("opens a run's chat, shows its live status, and credits the run with its workers", () => {
    const chat = structuredAgentSessionStatusPaneKey('run-chat')
    const activity = buildBotActivity(
      input({
        sessions: [],
        automations: [automation('a1')],
        runs: [run('r1', 'a1', { status: 'dispatched', chatSessionId: 'run-chat' })],
        workers: [worker('w1', { parentPaneKey: chat, taskTitle: 'From run chat' })],
        sessionStatus: (sessionId) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state and workingMode.
          sessionId === 'run-chat' ? ({ state: 'blocked' } as AgentStatusEntry) : null
      })
    )

    expect(activity.inProgress).toMatchObject([
      { kind: 'run', sessionId: 'run-chat', dot: 'blocked' }
    ])
    expect(activity.workers).toMatchObject([
      { kind: 'worker', origin: { kind: 'automation', name: 'Automation a1' } }
    ])
  })

  it("files runs that share a busy chat by each run's own status", () => {
    const activity = buildBotActivity(
      input({
        sessions: [],
        automations: [automation('a1')],
        runs: [
          run('done-1', 'a1', { chatSessionId: 'home', dispatchedAt: 1 }),
          run('done-2', 'a1', { chatSessionId: 'home', dispatchedAt: 2 }),
          run('failed', 'a1', {
            status: 'dispatch_failed',
            chatSessionId: 'home',
            dispatchedAt: 3
          }),
          run('live', 'a1', { status: 'dispatched', chatSessionId: 'home', dispatchedAt: 4 })
        ],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state and workingMode.
        sessionStatus: () => ({ state: 'working' }) as AgentStatusEntry
      })
    )

    expect(activity.inProgress).toMatchObject([{ key: 'run:live', dot: 'working' }])
    expect(activity.completed).toMatchObject([
      { key: 'run:failed', dot: 'failed' },
      { key: 'run:done-2', dot: 'done' },
      { key: 'run:done-1', dot: 'done' }
    ])
  })

  it('shows a run that failed or never started by its own status, over its chat’s done', () => {
    const activity = buildBotActivity(
      input({
        sessions: [],
        automations: [automation('a1')],
        runs: [
          run('failed', 'a1', { status: 'dispatch_failed', chatSessionId: 'failed-chat' }),
          run('skipped', 'a1', { status: 'skipped_unavailable', chatSessionId: 'skipped-chat' }),
          run('ok', 'a1', { status: 'completed', chatSessionId: 'ok-chat' })
        ],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model reads only state and workingMode.
        sessionStatus: () => ({ state: 'done' }) as AgentStatusEntry
      })
    )

    const dotByKey = Object.fromEntries(
      activity.completed.map((row) => [row.key, row.kind === 'run' ? row.dot : null])
    )
    expect(dotByKey).toEqual({ 'run:failed': 'failed', 'run:skipped': 'idle', 'run:ok': 'done' })
    expect(activity.inProgress).toEqual([])
  })
})

describe("a bot's waits", () => {
  it('lists waits apart from automations, deadline first, and drops one whose run started', () => {
    const activity = buildBotActivity({
      bot,
      sessions: [],
      links: [],
      workers: [],
      automations: [
        automation('daily'),
        automation('no-deadline', { once: {} }),
        automation('friday', { once: { by: 500 } }),
        automation('started', { once: { by: 400 } })
      ],
      runs: [run('r1', 'started', { status: 'dispatched', trigger: 'event' })],
      sessionStatus: () => null
    })
    expect(activity.automations.map((row) => row.key)).toEqual(['daily'])
    expect(activity.waits?.map((row) => row.key)).toEqual(['friday', 'no-deadline'])
  })
})

describe('agents in workspaces handed to the bot', () => {
  const waiting = { state: 'blocked' as const, prompt: 'May I push?', stateStartedAt: 9 }

  it('shows one another coordinator started, under its task, so its approval reaches Needs you', () => {
    const activity = buildBotActivity(
      input({
        workers: [
          worker('old:pane', { parentPaneKey: 'other-bot-chat:pane', taskTitle: 'Fix it' })
        ],
        handedAgents: [
          { paneKey: 'old:pane', entry: waiting, worktreeId: 'wt-handed', taskTitle: 'Fix it' }
        ]
      })
    )
    expect(activity.workers).toEqual([
      expect.objectContaining({
        key: 'agent:local:old:pane',
        title: 'Fix it',
        dot: 'blocked',
        dispatchId: '',
        workspaceId: 'wt-handed'
      })
    ])
  })

  it("lists an agent the bot's own Dispatch reaches once", () => {
    const activity = buildBotActivity(
      input({
        workers: [worker('mine:pane', { parentPaneKey: 'tab-home:pane' })],
        handedAgents: [{ paneKey: 'mine:pane', entry: waiting, worktreeId: 'wt-mine:pane' }]
      })
    )
    expect(activity.workers.map((row) => row.key)).toEqual(['worker:d-mine:pane'])
  })

  function chatWorker(
    host: OrchestrationSessionWorker['host'],
    paneKey: string
  ): NonNullable<BotActivityInput['recordedWorkers']>[number] {
    return {
      worker: {
        dispatchId: 'd-phone',
        taskId: 'task-phone',
        runId: 'run-1',
        title: 'Phone: one Bots list',
        agent: 'claude',
        state: 'working',
        liveness: 'live',
        host,
        worktreeId: 'wt-phone',
        paneKey,
        chatSessionId: null,
        startedAt: 50,
        settledAt: null
      },
      creatorSessionId: 'chat-session',
      creatorPaneKey: null
    }
  }
  const preamble = {
    state: 'working' as const,
    prompt: 'You are working inside Orca',
    stateStartedAt: 9
  }

  it("lists a worker the bot's chat started once, though its worktree is under the bot's home", () => {
    const activity = buildBotActivity(
      input({
        recordedWorkers: [chatWorker('local', 'phone:pane')],
        handedAgents: [
          { paneKey: 'phone:pane', entry: preamble, worktreeId: 'wt-phone' },
          { paneKey: 'own:pane', entry: waiting, worktreeId: 'wt-phone' }
        ]
      })
    )
    expect(activity.workers.map((row) => [row.key, row.title])).toEqual([
      ['worker:d-phone', 'Phone: one Bots list'],
      ['agent:local:own:pane', 'May I push?']
    ])
  })

  it('deduplicates a recorded paired worker and distinguishes agents across hosts', () => {
    const activity = buildBotActivity(
      input({
        recordedWorkers: [chatWorker('remote', 'remote:pane')],
        handedAgents: [
          {
            paneKey: 'remote:pane',
            entry: preamble,
            worktreeId: 'wt-phone',
            hostId: 'runtime:env-1'
          },
          { paneKey: 'p:1', entry: waiting, worktreeId: 'wt-local' },
          { paneKey: 'p:1', entry: waiting, worktreeId: 'wt-remote', hostId: 'runtime:env-1' }
        ]
      })
    )
    expect(activity.workers.map((row) => row.key)).toEqual([
      'worker:d-phone',
      'agent:local:p:1',
      'agent:runtime:env-1:p:1'
    ])
    expect(activity.workers.slice(1).map((row) => row.hostId)).toEqual([undefined, 'runtime:env-1'])
  })
})
