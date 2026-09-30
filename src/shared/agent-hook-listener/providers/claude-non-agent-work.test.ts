import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { makePaneKey } from '../../stable-pane-id'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { catchUpOnClaudeTranscript, syncClaudeTranscriptCursor } from './claude-transcript-watch'
import {
  claudePaneHasLaunchRecordedTask,
  claudePaneHasNonAgentWork,
  retireClaudeNonAgentTaskFromQueueRow
} from './claude-non-agent-work'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
// Shapes from the r1-s8k capture (Claude 2.1.284): the launching Bash call and TaskStop's result.
const LAUNCH = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 603', run_in_background: true },
  tool_response: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'bjomx789i'
  },
  tool_use_id: 'toolu_013mmtuc5E5usx7f8rnbFEk9'
}
const TASK_STOP = {
  hook_event_name: 'PostToolUse',
  tool_name: 'TaskStop',
  tool_input: { task_id: 'bjomx789i' },
  tool_response: {
    message: 'Successfully stopped task: bjomx789i (sleep 603)',
    task_id: 'bjomx789i',
    task_type: 'local_bash',
    command: 'sleep 603'
  },
  tool_use_id: 'toolu_01BYd1WsdTmm53R5kToRn4oa'
}

// Captured (r6-w1-run1, Claude 2.1.285): a background workflow's launching call and its result.
const WORKFLOW_LAUNCH = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Workflow',
  tool_input: { script: "export const meta = { name: 'capture-sleep' }" },
  tool_response: {
    status: 'async_launched',
    taskId: 'w1kuktaid',
    taskType: 'local_workflow',
    workflowName: 'capture-sleep',
    runId: 'wf_ca44ff70-bf9',
    summary: 'One agent runs a timed sleep'
  },
  tool_use_id: 'toolu_01S3s8SyG9VLFN3QhiERnGmU'
}
// Captured (claude-cancel-subagent-hooks, Claude 2.1.280): a background Agent call's result.
const AGENT_LAUNCH = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Agent',
  tool_response: {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a89b41394dcd804b3',
    description: 'Run 120s sleep command'
  },
  tool_use_id: 'toolu_01AgentLaunchAAAAAAAAAAA'
}

function claudeEvent(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey: PANE, payload }, 'production')
}

type EndFields = { taskId?: string; toolUseId?: string; status?: string }

function notification(fields: EndFields = {}): string {
  const { taskId = 'bjomx789i', toolUseId = LAUNCH.tool_use_id, status = 'killed' } = fields
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Task "Sleep" was stopped by the user</summary>\n</task-notification>`
}

/** The line shape Claude writes when a task ends (captured in claude-background-shell-*). */
function endLine(fields: EndFields = {}, operation = 'enqueue'): Record<string, unknown> {
  return {
    type: 'queue-operation',
    operation,
    timestamp: '2026-09-29T05:24:58.227Z',
    content: notification(fields)
  }
}

function launched(): HookListenerState {
  const state = createHookListenerState()
  claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
  expect(claudeEvent(state, LAUNCH)?.claudeRunningNonAgentTask).toBe(true)
  return state
}

describe('the Claude background task record', () => {
  it('records the launch with its tool call, and the stamp every row carries says so', () => {
    const state = launched()
    expect(state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks.get('bjomx789i')).toEqual({
      kind: 'unknown',
      launchToolUseId: LAUNCH.tool_use_id
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })

  it("ignores a subagent's launch", () => {
    const state = createHookListenerState()
    claudeEvent(state, { ...LAUNCH, agent_id: 'a1', agent_type: 'general-purpose' })
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it("retires the task on TaskStop's result, under any of the tool's names", () => {
    for (const toolName of ['TaskStop', 'KillShell', 'KillBash']) {
      const state = launched()
      expect(
        claudeEvent(state, { ...TASK_STOP, tool_name: toolName })?.claudeRunningNonAgentTask
      ).toBe(false)
    }
  })

  it('lets a Stop inventory replace the record, typing the task and keeping its launch', () => {
    const state = launched()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'bjomx789i', type: 'shell', status: 'running' },
        { id: 'bunlaunch', type: 'monitor', status: 'running' }
      ]
    })
    const tasks = state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks
    expect(tasks?.get('bjomx789i')).toEqual({
      kind: 'command',
      launchToolUseId: LAUNCH.tool_use_id
    })
    expect(tasks?.get('bunlaunch')).toEqual({ kind: 'monitor' })
    claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it('holds unnamed running work, and work past the id cap, until an inventory clears it', () => {
    const state = createHookListenerState()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [
        { type: 'shell', status: 'running' },
        ...Array.from({ length: 70 }, (_, index) => ({
          id: `b${index}`,
          type: 'shell',
          status: 'running'
        }))
      ]
    })
    const work = state.claudeNonAgentWorkByPaneKey.get(PANE)
    expect(work?.tasks.size).toBe(64)
    expect(work?.hasUnnamedRunning).toBe(true)
    claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })
    expect(state.claudeNonAgentWorkByPaneKey.has(PANE)).toBe(false)
  })

  it('keeps the record across a new session in the pane: a shell survives /clear', () => {
    const state = launched()
    claudeEvent(state, {
      hook_event_name: 'SessionStart',
      source: 'clear',
      session_id: '00000000-0000-4000-8000-0000000000c1'
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })

  it("clears the record when a new process starts: it can never end its predecessor's tasks", () => {
    for (const source of ['startup', 'resume']) {
      const state = launched()
      const started = claudeEvent(state, {
        hook_event_name: 'SessionStart',
        source,
        session_id: '00000000-0000-4000-8000-0000000000c2'
      })
      expect(started?.payload).toMatchObject({ state: 'done', sessionBoundary: true })
      expect(started?.payload.workingMode).toBeUndefined()
      expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
    }
  })
})

describe('what a launch records', () => {
  function recordsFrom(payload: Record<string, unknown>) {
    const state = createHookListenerState()
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
    claudeEvent(state, payload)
    return state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks
  }

  function workflowLaunchWith(response: Record<string, unknown>) {
    return { ...WORKFLOW_LAUNCH, tool_response: response }
  }

  it('records a workflow from its async launch, typed from its taskType', () => {
    expect(recordsFrom(WORKFLOW_LAUNCH)).toEqual(
      new Map([['w1kuktaid', { kind: 'workflow', launchToolUseId: WORKFLOW_LAUNCH.tool_use_id }]])
    )
  })

  it('records a shell from backgroundTaskId, its kind left for an inventory to type', () => {
    expect(recordsFrom(LAUNCH)?.get('bjomx789i')).toEqual({
      kind: 'unknown',
      launchToolUseId: LAUNCH.tool_use_id
    })
  })

  // Hand-built from the captured workflow launch: no capture has these kinds' launch results.
  it('records any kind the table does not call an agent, unknown ones included, as the inventory does', () => {
    const { taskType: _captured, ...untyped } = WORKFLOW_LAUNCH.tool_response
    for (const response of [
      { ...WORKFLOW_LAUNCH.tool_response, taskType: 'remote_agent' },
      { ...WORKFLOW_LAUNCH.tool_response, taskType: 'monitor_ws' },
      untyped
    ]) {
      expect(recordsFrom(workflowLaunchWith(response))?.get('w1kuktaid')?.kind).toBe('unknown')
    }
  })

  // Temporary: the shared table calls `in_process_teammate` unknown; its fix is its own change.
  it('records a teammate launch naming a taskId (hand-built, uncaptured) until the next inventory', () => {
    const teammate = { ...WORKFLOW_LAUNCH.tool_response, taskType: 'in_process_teammate' }
    expect(recordsFrom(workflowLaunchWith(teammate))?.get('w1kuktaid')?.kind).toBe('unknown')
  })

  it('leaves agents to the rosters', () => {
    expect(recordsFrom(AGENT_LAUNCH)).toBeUndefined()
    // Hand-built: a future launch that names an agent by taskId.
    for (const taskType of ['local_agent', 'subagent']) {
      const agent = { ...WORKFLOW_LAUNCH.tool_response, taskType }
      expect(recordsFrom(workflowLaunchWith(agent))).toBeUndefined()
    }
  })

  // Hand-built: a taskId outside Claude's background-launch result, from any other tool.
  it('ignores a taskId that is not an async launch', () => {
    const { status: _captured, ...unmarked } = WORKFLOW_LAUNCH.tool_response
    expect(recordsFrom(workflowLaunchWith(unmarked))).toBeUndefined()
    const finished = { ...WORKFLOW_LAUNCH.tool_response, status: 'completed' }
    expect(recordsFrom(workflowLaunchWith(finished))).toBeUndefined()
  })

  it("ignores a subagent's workflow launch", () => {
    expect(
      recordsFrom({ ...WORKFLOW_LAUNCH, agent_id: 'a1', agent_type: 'general-purpose' })
    ).toBeUndefined()
  })

  it('keeps the kind an inventory already gave the task', () => {
    const state = createHookListenerState()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'w1kuktaid', type: 'monitor', status: 'running' }]
    })
    claudeEvent(state, WORKFLOW_LAUNCH)
    expect(state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks.get('w1kuktaid')).toEqual({
      kind: 'monitor',
      launchToolUseId: WORKFLOW_LAUNCH.tool_use_id
    })
  })
})

describe('the task end line in the transcript', () => {
  it('retires the task only for its launch-recorded task id and tool call', () => {
    const state = launched()
    expect(
      retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine({ toolUseId: 'toolu_other' }))
    ).toBe(false)
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine({ taskId: 'bother' }))).toBe(
      false
    )
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine())).toBe(true)
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it('never retires on typed text, a running status, a removal, or two notifications in one line', () => {
    const state = launched()
    const matched = endLine()
    // Captured (r3-typed-run1): a prompt typed while Claude is busy writes this row shape.
    const typed = { ...matched, content: 'Capture step 2: reply with exactly the word QUEUED.' }
    const twice = { ...matched, content: `${notification()}\n${notification()}` }
    for (const line of [
      typed,
      endLine({ status: 'running' }),
      endLine({}, 'remove'),
      twice,
      { ...matched, type: 'user' }
    ]) {
      expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, line)).toBe(false)
    }
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })

  // Hand-built from the captured workflow end row (r6-w1-run1), whose `<result>` is the agents'
  // own text: nothing in it may end the task early or retire another one.
  it('reads a workflow end row by the fields before its agent-written result', () => {
    const state = createHookListenerState()
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start them' })
    claudeEvent(state, WORKFLOW_LAUNCH)
    claudeEvent(state, {
      ...WORKFLOW_LAUNCH,
      tool_response: { ...WORKFLOW_LAUNCH.tool_response, taskId: 'wsecond01' },
      tool_use_id: 'toolu_01SecondWorkflowAAAAAAA'
    })
    const workflowEnd = (result: string) => ({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-09-30T17:00:28.690Z',
      content: `<task-notification>\n<task-id>w1kuktaid</task-id>\n<tool-use-id>${WORKFLOW_LAUNCH.tool_use_id}</tool-use-id>\n<status>completed</status>\n<summary>Dynamic workflow "One agent runs a timed sleep" completed</summary>\n<result>${result}</result>\n</task-notification>`
    })
    expect(
      retireClaudeNonAgentTaskFromQueueRow(
        state,
        PANE,
        workflowEnd('"<task-notification><task-id>w1kuktaid</task-id></task-notification>"')
      )
    ).toBe(false)
    expect(state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks.size).toBe(2)

    expect(
      retireClaudeNonAgentTaskFromQueueRow(
        state,
        PANE,
        workflowEnd(
          '"<task-id>wsecond01</task-id><tool-use-id>toolu_01SecondWorkflowAAAAAAA</tool-use-id>"'
        )
      )
    ).toBe(true)
    expect([...(state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks.keys() ?? [])]).toEqual([
      'wsecond01'
    ])
  })

  it('leaves a task only an inventory named (no recorded launch) for the next inventory', () => {
    const state = createHookListenerState()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'bjomx789i', type: 'shell', status: 'running' }]
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(false)
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine())).toBe(false)
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(true)
  })
})

function inTranscriptDir(run: (transcript: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orca-background-shell-watch-'))
  try {
    const transcript = join(dir, 'session.jsonl')
    writeFileSync(transcript, '')
    run(transcript)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function launchEvent(
  state: HookListenerState,
  transcript: string,
  launch: Record<string, unknown> = LAUNCH
) {
  const event = claudeEvent(state, {
    ...launch,
    session_id: '00000000-0000-4000-8000-0000000000d1',
    transcript_path: transcript
  })
  if (!event) {
    throw new Error('listener produced no event')
  }
  return event
}

describe('watching for the end line', () => {
  it('parses only queue-operation lines that carry a notification, never the per-turn snapshot', () => {
    inTranscriptDir((transcript) => {
      const state = createHookListenerState()
      claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
      expect(syncClaudeTranscriptCursor(state, launchEvent(state, transcript))).toBe(true)
      // Hand-built at the size of the per-turn prompt_snapshot attachment, which quotes the tag.
      const snapshot = JSON.stringify({
        type: 'attachment',
        text: `<task-notification> ${'x'.repeat(56 * 1024)}`
      })
      appendFileSync(transcript, `${snapshot}\n${JSON.stringify(endLine())}\n`)
      const parse = vi.spyOn(JSON, 'parse')
      catchUpOnClaudeTranscript(state, PANE)
      expect(parse).toHaveBeenCalledTimes(1)
      parse.mockRestore()
      expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
    })
  })

  // Hand-placed order: no capture has a task that ends before Orca handles its launch hook.
  it('finds the end row of a task that ended before its launch hook, behind a cursor armed at the end', () => {
    inTranscriptDir((transcript) => {
      const state = createHookListenerState()
      claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
      appendFileSync(transcript, `${JSON.stringify(endLine({ status: 'failed' }))}\n`)
      const launch = launchEvent(state, transcript)
      expect(launch.claudeRunningNonAgentTask).toBe(true)
      expect(syncClaudeTranscriptCursor(state, launch)).toBe(true)
      expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
      expect(state.claudeTranscriptCursorByPaneKey.get(PANE)?.unpublished).toEqual({})
    })
  })

  it('finds it behind a cursor the catch-up before the launch hook already read past', () => {
    inTranscriptDir((transcript) => {
      const state = createHookListenerState()
      claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
      const earlier = { ...LAUNCH, tool_response: { backgroundTaskId: 'bearlier1' } }
      const first = launchEvent(state, transcript, { ...earlier, tool_use_id: 'toolu_earlier' })
      expect(syncClaudeTranscriptCursor(state, first)).toBe(true)
      appendFileSync(transcript, `${JSON.stringify(endLine({ status: 'failed' }))}\n`)
      // The server's catch-up before normalizing the launch reads the row while no task matches it.
      catchUpOnClaudeTranscript(state, PANE)
      const launch = launchEvent(state, transcript)
      expect(syncClaudeTranscriptCursor(state, launch)).toBe(true)
      const tasks = state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks
      expect(tasks?.has('bjomx789i')).toBe(false)
      expect(tasks?.has('bearlier1')).toBe(true)
    })
  })
})
