// Model stream-json initialize and short prompt turns without a real Claude CLI; generated wrappers pass the launch log first.
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')

const [launchLog, ...args] = process.argv.slice(2)
fs.appendFileSync(launchLog, `${JSON.stringify({ pid: process.pid, args })}\n`)

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('2.1.280 (Claude Code)\n')
  process.exit(0)
}

function argValue(name) {
  const joined = args.find((arg) => arg.startsWith(`${name}=`))
  if (joined) {
    return joined.slice(name.length + 1)
  }
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}

const sessionId = argValue('--session-id') ?? argValue('--resume') ?? randomUUID()
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const initializeResponse = {
  commands: [],
  models: [{ value: 'default', displayName: 'Default', description: '' }],
  account: {},
  output_style: 'default',
  available_output_styles: ['default']
}

// A prompt containing "slow" runs until it is interrupted.
const TURN_MS = 500
const SLOW_TURN_MS = 60_000
let turnTimer = null

function startTurn(frame) {
  // The CLI's --replay-user-messages echo, which opens the turn.
  write({ ...frame, isReplay: true })
  const slow = JSON.stringify(frame.message ?? '').includes('slow')
  turnTimer = setTimeout(
    () => {
      turnTimer = null
      write({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: randomUUID(),
          role: 'assistant',
          model: 'claude-fake',
          content: [{ type: 'text', text: 'Stub reply.' }]
        }
      })
      write({
        type: 'result',
        subtype: 'success',
        uuid: randomUUID(),
        session_id: sessionId,
        is_error: false,
        terminal_reason: 'completed',
        result: 'Stub reply.'
      })
    },
    slow ? SLOW_TURN_MS : TURN_MS
  )
}

function interruptTurn() {
  if (!turnTimer) {
    return
  }
  clearTimeout(turnTimer)
  turnTimer = null
  write({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: sessionId,
    parent_tool_use_id: null
  })
}

let buffer = ''
let initSent = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    let frame
    try {
      frame = line ? JSON.parse(line) : null
    } catch {
      frame = null
    }
    fs.appendFileSync(
      `${launchLog}.requests.jsonl`,
      `${JSON.stringify({
        pid: process.pid,
        type: frame?.type ?? null,
        subtype: frame?.request?.subtype ?? null
      })}\n`
    )
    if (frame?.type === 'user') {
      startTurn(frame)
      continue
    }
    if (frame?.type !== 'control_request') {
      continue
    }
    const subtype = frame.request?.subtype
    if (subtype === 'interrupt') {
      interruptTurn()
    }
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: subtype === 'initialize' ? initializeResponse : {}
      }
    })
    if (subtype === 'initialize' && !initSent) {
      initSent = true
      write({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: randomUUID(),
        model: 'claude-fake',
        cwd: process.cwd(),
        tools: [],
        mcp_servers: [],
        permissionMode: 'default',
        slash_commands: [],
        apiKeySource: 'none',
        output_style: 'default'
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
