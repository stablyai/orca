#!/usr/bin/env node
// Replays a canned streaming answer over the Anthropic Messages API and the OpenAI Responses API.
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.env.STUB_PORT || 8089)
const HOST = process.env.STUB_HOST || '127.0.0.1'
const LOG_FILE = process.env.STUB_LOG || '/tmp/agent-stub/requests.log'
const CONFIG_FILE = process.env.STUB_CONFIG || '/tmp/agent-stub/config.json'
const DUMP_DIR = process.env.STUB_DUMP_DIR || ''
const TICK_MS = 50

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
if (DUMP_DIR) {
  fs.mkdirSync(DUMP_DIR, { recursive: true })
}

// Re-read per request so pace and length can change without a restart.
function settings() {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {}
  const pick = (key, env, fallback) => {
    const value = Number(file[key] ?? process.env[env] ?? fallback)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    totalLines: Math.round(pick('total_lines', 'STUB_LINES', 300)),
    charsPerSecond: pick('chars_per_second', 'STUB_CPS', 400)
  }
}

let seq = 0
function log(entry) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
}

// Every non-blank line carries an L<number> marker so scroll position is readable on screen.
// The number keeps counting across answers, so no two lines in a transcript look alike and a
// screen's position is exact even where one answer ends and the next begins.
let linesEmitted = 0
function cannedMarkdown(totalLines) {
  const out = []
  let n = 0
  const tag = () => (n++, `L${String(++linesEmitted).padStart(4, '0')}`)
  const left = () => totalLines - n
  let section = 0
  while (left() > 0) {
    section++
    out.push(`## ${tag()} Section ${section} of the canned answer`, '')
    if (left() > 0) {
      out.push(
        `${tag()} This paragraph belongs to section ${section}. It is deliberately long enough to wrap on a narrow phone screen, so the harness can check soft wrapping as well as scrolling.`,
        ''
      )
    }
    if (left() >= 6) {
      out.push('```js')
      out.push(`// ${tag()} code block in section ${section}`)
      out.push(`function step${section}(input) { // ${tag()}`)
      out.push(`  const doubled = input * 2 // ${tag()}`)
      out.push(`  return doubled + ${section} // ${tag()}`)
      out.push(`} // ${tag()}`)
      out.push('```', '')
    }
    for (let item = 1; item <= 18 && left() > 0; item++) {
      out.push(
        `${item}. ${tag()} list item ${item} in section ${section}: the quick brown fox jumps over the lazy dog`
      )
    }
    out.push('')
  }
  out.push(`End of canned answer after ${n} numbered lines.`)
  return out.join('\n')
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({ _unparsed: raw.slice(0, 200) })
      }
    })
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_stub_${seq}` })
  res.end(text)
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': `req_stub_${seq}`
  })
  return (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
}

// Emits `text` in fixed ticks at the configured pace; stops if the client goes away.
function paced(res, text, charsPerSecond, onChunk) {
  return new Promise((resolve) => {
    const perTick = Math.max(1, Math.round((charsPerSecond * TICK_MS) / 1000))
    const chars = Array.from(text)
    let offset = 0
    let closed = false
    res.on('close', () => {
      closed = true
    })
    const timer = setInterval(() => {
      if (closed || offset >= chars.length) {
        clearInterval(timer)
        resolve(!closed)
        return
      }
      onChunk(chars.slice(offset, offset + perTick).join(''))
      offset += perTick
    }, TICK_MS)
  })
}

const usage = (outputChars) => ({
  input_tokens: 1200,
  output_tokens: Math.ceil(outputChars / 4),
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
})

// Claude Code (output_config.format) and Codex (text.format) both ask for session titles as JSON.
function requestedSchema(body) {
  const format = body.output_config?.format ?? body.output_format ?? body.text?.format
  return format?.type === 'json_schema' ? (format.schema ?? {}) : null
}

// Side requests (titles, quota probes, small-model calls) get a short instant reply.
function isMainTurn(body) {
  if (requestedSchema(body)) {
    return false
  }
  if (typeof body.max_tokens === 'number' && body.max_tokens <= 1024) {
    return false
  }
  return !/haiku|mini|nano/i.test(String(body.model ?? ''))
}

function shortAnswer(body) {
  const schema = requestedSchema(body)
  if (!schema) {
    return 'Stub canned answer'
  }
  const answer = {}
  for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
    const type = schema.properties?.[key]?.type
    answer[key] =
      type === 'boolean'
        ? false
        : type === 'number' || type === 'integer'
          ? 0
          : 'Stub canned answer'
  }
  return JSON.stringify(answer)
}

async function anthropicMessages(body, res) {
  const cfg = settings()
  const main = isMainTurn(body)
  const text = main ? cannedMarkdown(cfg.totalLines) : shortAnswer(body)
  const message = {
    id: `msg_stub_${seq}`,
    type: 'message',
    role: 'assistant',
    model: body.model || 'stub-model',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...usage(0), output_tokens: 1 }
  }
  if (!body.stream) {
    sendJson(res, 200, {
      ...message,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: usage(text.length)
    })
    return
  }
  const send = startSse(res)
  send('message_start', { message })
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  send('ping', {})
  const finished = await paced(res, text, main ? cfg.charsPerSecond : 1e6, (chunk) =>
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } })
  )
  log({
    seq: message.id,
    method: 'STREAM-END',
    path: '/v1/messages',
    model: message.model,
    completed: finished,
    turn: main ? 'main' : 'side'
  })
  if (!finished) {
    return
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(text.length / 4) }
  })
  send('message_stop', {})
  res.end()
}

async function openaiResponses(body, res) {
  const cfg = settings()
  const main = isMainTurn(body)
  const text = main ? cannedMarkdown(cfg.totalLines) : shortAnswer(body)
  const responseId = `resp_stub_${seq}`
  const itemId = `msg_stub_${seq}`
  const outputTokens = Math.ceil(text.length / 4)
  const response = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: body.model || 'stub-model',
    output: []
  }
  const doneItem = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  }
  const completed = {
    ...response,
    status: 'completed',
    output: [doneItem],
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1200 + outputTokens
    }
  }
  if (body.stream === false) {
    sendJson(res, 200, completed)
    return
  }
  const send = startSse(res)
  let sequence = 0
  const emit = (event, data) => send(event, { sequence_number: sequence++, ...data })
  emit('response.created', { response })
  emit('response.in_progress', { response })
  emit('response.output_item.added', {
    output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  })
  emit('response.content_part.added', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  })
  const finished = await paced(res, text, main ? cfg.charsPerSecond : 1e6, (chunk) =>
    emit('response.output_text.delta', {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: chunk
    })
  )
  log({
    seq: responseId,
    method: 'STREAM-END',
    path: '/v1/responses',
    model: response.model,
    completed: finished,
    turn: main ? 'main' : 'side'
  })
  if (!finished) {
    return
  }
  emit('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text })
  emit('response.content_part.done', {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: doneItem.content[0]
  })
  emit('response.output_item.done', { output_index: 0, item: doneItem })
  emit('response.completed', { response: completed })
  res.end()
}

const server = http.createServer(async (req, res) => {
  seq++
  const url = new URL(req.url, `http://${req.headers.host || 'stub'}`)
  const route = url.pathname.replace(/\/+$/, '')
  const body = req.method === 'POST' ? await readBody(req) : {}
  const main = /\/(messages|responses)$/.test(route) && isMainTurn(body)
  log({
    seq,
    method: req.method,
    path: url.pathname + url.search,
    model: body.model ?? null,
    stream: body.stream ?? null,
    kind: req.method === 'POST' ? (main ? 'main-turn' : 'side-request') : 'aux',
    user_agent: req.headers['user-agent'] ?? null
  })
  if (DUMP_DIR && req.method === 'POST') {
    fs.writeFileSync(
      path.join(DUMP_DIR, `${String(seq).padStart(4, '0')}.json`),
      JSON.stringify(body, null, 1)
    )
  }
  res.on('error', () => {})

  if (req.method === 'POST' && route.endsWith('/messages/count_tokens')) {
    sendJson(res, 200, { input_tokens: 1200 })
  } else if (req.method === 'POST' && route.endsWith('/messages')) {
    await anthropicMessages(body, res)
  } else if (req.method === 'POST' && route.endsWith('/responses')) {
    await openaiResponses(body, res)
  } else if (req.method === 'GET' && route.endsWith('/models')) {
    sendJson(res, 200, { object: 'list', data: [], models: [], has_more: false })
  } else if (route === '/healthz') {
    sendJson(res, 200, { ok: true, linesEmitted, ...settings() })
  } else {
    sendJson(res, 200, {})
  }
})

server.listen(PORT, HOST, () => {
  log({ seq: 0, method: 'START', path: `http://${HOST}:${PORT}`, model: null, ...settings() })
})
