#!/usr/bin/env node

const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}

const fixtureRoot = process.env.ORCA_E2E_OCH_ROOT || path.join(os.tmpdir(), 'orca-och-integ')
const cliEntry = process.env.ORCA_E2E_CLI_ENTRY
const terminalHandle = process.env.ORCA_TERMINAL_HANDLE || 'unknown-terminal'
const paneKey = process.env.ORCA_PANE_KEY || ''
const tabId = process.env.ORCA_TAB_ID || ''
const worktreeId = process.env.ORCA_WORKTREE_ID || ''
const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN || ''
const providerSessionId = `och-session-${terminalHandle}`
const childId = `och-child-${terminalHandle.replaceAll(/[^A-Za-z0-9-]/g, '-')}`
const safeHandle = terminalHandle.replaceAll(/[^A-Za-z0-9_-]/g, '_')
const ledgerPath = path.join(fixtureRoot, 'worker-ledger.jsonl')
const userDataPath = readFileSync(path.join(fixtureRoot, 'user-data-path'), 'utf8').trim()
const transcriptPath = path.join(fixtureRoot, `parent-${safeHandle}.jsonl`)
const childTranscriptPath = path.join(fixtureRoot, `rollout-child-${childId}.jsonl`)
const controlPath = path.join(fixtureRoot, `worker-control-${safeHandle}.txt`)

mkdirSync(fixtureRoot, { recursive: true })
writeFileSync(transcriptPath, '')
writeFileSync(childTranscriptPath, '')

let capability = null
let taskId = null
let dispatchId = null
let inputBuffer = ''
let initialized = false
let childStarted = false
let pending = Promise.resolve()
const handledMarkers = new Set()

function record(event, details = {}) {
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ event, terminalHandle, taskId, dispatchId, ...details })}\n`
  )
}

async function postHook(payload) {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  if (!port || !token) {
    record('hook-failed', { reason: 'missing-endpoint' })
    return
  }
  const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': token
    },
    body: JSON.stringify({
      paneKey,
      tabId,
      worktreeId,
      launchToken,
      env: process.env.ORCA_AGENT_HOOK_ENV || 'development',
      version: process.env.ORCA_AGENT_HOOK_VERSION || '1',
      payload
    })
  })
  record('hook', { hookEventName: payload.hook_event_name, status: response.status })
}

function runCli(args) {
  if (!cliEntry) {
    throw new Error('ORCA_E2E_CLI_ENTRY is missing')
  }
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_DEV_CLI_INVOCATION: '1'
    },
    encoding: 'utf8'
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

function lifecycleArgs(type, subject, body) {
  return [
    'orchestration',
    'send',
    '--from',
    terminalHandle,
    '--dispatch-capability',
    capability,
    '--type',
    type,
    '--subject',
    subject,
    '--body',
    body,
    '--task-id',
    taskId,
    '--dispatch-id',
    dispatchId,
    '--json'
  ]
}

function consumeMarker(marker) {
  if (handledMarkers.has(marker) || !inputBuffer.includes(marker)) {
    return false
  }
  handledMarkers.add(marker)
  return true
}

async function initialize() {
  if (initialized || !capability || !taskId || !dispatchId) {
    return
  }
  initialized = true
  await postHook({
    hook_event_name: 'PreToolUse',
    session_id: providerSessionId,
    tool_use_id: `lead-ready-${safeHandle}`,
    tool_name: 'Read'
  })
  const heartbeat = runCli([
    ...lifecycleArgs('heartbeat', 'alive', 'Worker is validating the composed contract.'),
    '--phase',
    'Validating public bootstrap'
  ])
  record('ready', { heartbeat })
  process.stdout.write('OCH_WORKER_READY\n')
}

async function startChild() {
  if (childStarted) {
    return
  }
  childStarted = true
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        occurred_at_ms: Date.now(),
        agent_thread_id: childId,
        agent_path: '/root/accessibility_review',
        kind: 'started'
      }
    })}\n`
  )
  appendFileSync(
    childTranscriptPath,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
  )
  await postHook({
    hook_event_name: 'PostToolUse',
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    tool_name: 'collaborationspawn_agent'
  })
  record('child-started', { childId })
}

async function rejectChildSettlement() {
  await startChild()
  await postHook({
    hook_event_name: 'PreToolUse',
    agent_id: childId,
    tool_use_id: `child-settle-${safeHandle}`,
    tool_name: 'exec_command'
  })
  const result = runCli([
    ...lifecycleArgs(
      'worker_done',
      'Child attempted completion',
      'The child inspected accessibility. The parent still owns settlement. No parent result was accepted.'
    ),
    '--outcome',
    'succeeded'
  ])
  record('child-settlement', { result })
}

async function completeChild() {
  if (!childStarted) {
    return
  }
  appendFileSync(
    childTranscriptPath,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
  )
  await postHook({
    hook_event_name: 'PostToolUse',
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    tool_name: 'collaborationwait_agent'
  })
  record('child-completed')
}

async function settleParent() {
  await postHook({
    hook_event_name: 'PreToolUse',
    session_id: providerSessionId,
    tool_use_id: `lead-settle-${safeHandle}`,
    tool_name: 'exec_command'
  })
  const result = runCli([
    ...lifecycleArgs(
      'worker_done',
      'Completed integration work',
      'The worker completed its bounded integration task. The public contract was exercised. Nothing remains for this worker.'
    ),
    '--outcome',
    'succeeded'
  ])
  record('parent-settlement', { result })
}

process.stdout.write('\u001b]0;Codex Ready\u0007OpenAI Codex\nmodel: e2e\ndirectory: e2e\n')
function scheduleInput(input) {
  inputBuffer = `${inputBuffer}${input}`.slice(-200_000)
  capability ||= inputBuffer.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1] || null
  taskId ||= inputBuffer.match(/--task-id ([A-Za-z0-9._-]+)/)?.[1] || null
  dispatchId ||= inputBuffer.match(/--dispatch-id ([A-Za-z0-9._-]+)/)?.[1] || null
  pending = pending.then(initialize).catch((error) => record('error', { error: String(error) }))
  if (consumeMarker('OCH_START_CHILD')) {
    pending = pending.then(startChild).catch((error) => record('error', { error: String(error) }))
  }
  if (consumeMarker('OCH_CHILD_SETTLE')) {
    pending = pending
      .then(rejectChildSettlement)
      .catch((error) => record('error', { error: String(error) }))
  }
  if (consumeMarker('OCH_COMPLETE_CHILD')) {
    pending = pending
      .then(completeChild)
      .catch((error) => record('error', { error: String(error) }))
  }
  if (consumeMarker('OCH_PARENT_SETTLE')) {
    pending = pending.then(settleParent).catch((error) => record('error', { error: String(error) }))
  }
  if (consumeMarker('OCH_EXIT')) {
    pending.finally(() => {
      record('exit-requested')
      process.exit(0)
    })
  }
}

process.stdin.on('data', (chunk) => {
  process.stdout.write('OCH_WORKER_ACK\n')
  scheduleInput(chunk.toString())
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {
  if (existsSync(controlPath)) {
    scheduleInput(readFileSync(controlPath, 'utf8'))
  }
}, 50)
