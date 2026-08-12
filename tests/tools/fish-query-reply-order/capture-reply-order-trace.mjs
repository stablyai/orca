#!/usr/bin/env node
/**
 * Ground-truth repro harness for #13892: terminal query replies reach a POSIX pty
 * OUT OF THE ORDER the queries were observed, so fish's DA1 read sentinel hands the
 * tty to the child before the OSC 11 reply lands — and the child reads it as stdin.
 *
 * The pipeline below is Orca's, not a mock of it:
 *
 *   real fish (node-pty)
 *     -> PtyStartupIngress.accept()                  (src/shared/pty-startup-ingress.ts)
 *     -> onEmission                                   == what the renderer's xterm sees
 *     -> renderer model: parse queries IN STREAM ORDER, emit one reply per query
 *     -> providerWrite()                              == local-pty-provider.write() VERBATIM
 *          echo-safe (OSC / private DSR) -> ingress.answerLiveQueryReply -> PtyStartupReplyDelivery
 *          everything else               -> pty.write immediately
 *
 * The renderer model answers strictly in the order the queries appeared in the
 * stream. It never reorders. Any inversion the trace shows is produced by the
 * delivery split alone. (A previous harness for the sibling bug answered DA1 first
 * unconditionally, which no real terminal does, and its evidence was worthless.)
 *
 * Usage:
 *   node tests/tools/fish-query-reply-order/capture-reply-order-trace.mjs [options]
 *
 * Default mode now runs the SHIPPED fix, since providerWrite is still the host gate
 * verbatim; the two modes below are the controls it was compared against.
 *
 *   --bypass-echo-safe  control: write every reply straight to the pty, in order
 *   --order-fifo        control: the fix modelled in-harness instead of in src, so the
 *                       two can be compared — an immediate reply may not overtake an
 *                       echo-safe reply queued before it
 *   --uniform-delay=<ms> control: every reply delayed by <ms>, still in order —
 *                       separates "late" from "out of order"
 *   --shell=<path>      fish binary (default /opt/homebrew/bin/fish)
 *   --no-typeahead      type the command at an idle prompt instead of type-ahead
 *   --settle=<ms>       quiet time after the first prompt (default 500)
 *   --json              append a machine-readable summary line
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

// The delivery class uses constructor parameter properties, which strip-only mode rejects.
if (process.features.typescript !== 'transform') {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

// Orca's src/ uses extensionless relative imports; node's TS resolver does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const require = createRequire(import.meta.url)
const pty = require(path.join(REPO_ROOT, 'node_modules/node-pty'))
const { PtyStartupIngress } = await import(path.join(REPO_ROOT, 'src/shared/pty-startup-ingress.ts'))
const { extractOnlyCookedEchoSafeQueryReplies } = await import(
  path.join(REPO_ROOT, 'src/shared/terminal-query-reply.ts')
)
const { createPtySlaveEchoProbe, createPtySlaveEchoSyncProbe, readPtySlavePath } = await import(
  path.join(REPO_ROOT, 'src/shared/pty-slave-line-discipline-echo.ts')
)
const { resolvePtyOwnerBackend } = await import(
  path.join(REPO_ROOT, 'src/shared/pty-owner-backend.ts')
)

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const SHELL = opt('shell', '/opt/homebrew/bin/fish')
const BYPASS_ECHO_SAFE = flag('bypass-echo-safe')
const ORDER_FIFO = flag('order-fifo')
const TYPEAHEAD = !flag('no-typeahead')
const SETTLE_MS = Number(opt('settle', '500'))
const TYPEAHEAD_AT_MS = Number(opt('typeahead-at', '150'))
const EMIT_JSON = flag('json')
const UNIFORM_DELAY_MS = Number(opt('uniform-delay', '-1'))
const MODE =
  UNIFORM_DELAY_MS >= 0
    ? `uniform-delay-${UNIFORM_DELAY_MS}ms`
    : BYPASS_ECHO_SAFE
      ? 'bypass-echo-safe'
      : ORDER_FIFO
        ? 'order-fifo'
        : 'main'

if ([BYPASS_ECHO_SAFE, ORDER_FIFO, UNIFORM_DELAY_MS >= 0].filter(Boolean).length > 1) {
  console.error('--bypass-echo-safe, --order-fifo and --uniform-delay are mutually exclusive')
  process.exit(2)
}

const PROMPT_MARK = 'HARNESS> '
const LEAK_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'fish-reply-order-')), 'child-stdin.txt')
const CHILD_CMD = `python3 -c 'import sys, os; d = sys.stdin.readline(); open(os.environ["ORCA_LEAK_OUT"], "w").write(d); print("GOT:", repr(d))'`

// ---------------------------------------------------------------- tracing

const t0 = process.hrtime.bigint()
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6
const trace = []
function log(dir, label, detail) {
  const line = `[${ms().toFixed(3).padStart(10, ' ')}ms] ${dir.padEnd(16)} ${label}${detail ? ` ${detail}` : ''}`
  trace.push(line)
  console.log(line)
}

function esc(s) {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (ch === '\x1b') {
      out += '\\e'
    } else if (ch === '\n') {
      out += '\\n'
    } else if (ch === '\r') {
      out += '\\r'
    } else if (ch === '\t') {
      out += '\\t'
    } else if (c < 0x20 || c === 0x7f) {
      out += `\\x${c.toString(16).padStart(2, '0')}`
    } else {
      out += ch
    }
  }
  return out
}
const CHUNK_CAP = 900
const escCapped = (s) => {
  const e = esc(s)
  return e.length > CHUNK_CAP ? `${e.slice(0, CHUNK_CAP)}…<+${e.length - CHUNK_CAP}>` : e
}

// ---------------------------------------------------------------- fish config

const configHome = mkdtempSync(path.join(tmpdir(), 'fish-reply-order-cfg-'))
mkdirSync(path.join(configHome, 'fish'), { recursive: true })
writeFileSync(
  path.join(configHome, 'fish/config.fish'),
  [
    'set -g fish_greeting ""',
    `function fish_prompt; printf '${PROMPT_MARK}'; end`,
    'function fish_right_prompt; end',
    ''
  ].join('\n')
)
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: path.join(configHome, 'data'),
  ORCA_LEAK_OUT: LEAK_FILE
}
delete env.FISH_HISTORY

// ---------------------------------------------------------------- pty + Orca pipeline

log(
  'HARNESS',
  'config',
  JSON.stringify({ mode: MODE, shell: SHELL, typeahead: TYPEAHEAD, settleMs: SETTLE_MS, leakFile: LEAK_FILE })
)

const term = pty.spawn(SHELL, ['-l', '-i'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: REPO_ROOT,
  env
})

let rawOutput = ''
let ptyWriteSeq = 0
const replies = []
/** Every byte that actually reaches the pty master, in real order. */
function ptyWrite(data, route, replyRecord) {
  const seq = ++ptyWriteSeq
  if (replyRecord) {
    replyRecord.writeSeq = seq
    replyRecord.writtenAt = ms()
    replyRecord.route = route
  }
  log('ORCA->PTY', `write#${seq} ${route}`, `"${esc(data)}"`)
  term.write(data)
}

const ownerBackend = resolvePtyOwnerBackend({ platform: process.platform, shellPath: SHELL })
const echoProbe = createPtySlaveEchoProbe(readPtySlavePath(term))
const echoSyncProbe = createPtySlaveEchoSyncProbe(term)
log(
  'HARNESS',
  'pipeline',
  JSON.stringify({
    ownerBackend,
    echoProbe: Boolean(echoProbe),
    echoSyncProbe: Boolean(echoSyncProbe),
    ptsName: readPtySlavePath(term) ?? null
  })
)

// FIFO model: an immediate reply may not overtake an echo-safe reply queued ahead of it.
const fifo = { deferred: 0, held: [] }

const ingress = new PtyStartupIngress({
  ownerBackend,
  write: (data) => {
    const record = deferredByReply.get(data)?.shift()
    ptyWrite(data, `delivery-flush(${record?.echoSafe === false ? 'in-order' : 'echo-safe'})`, record)
    if (!ORDER_FIFO) {
      return
    }
    fifo.deferred = Math.max(0, fifo.deferred - 1)
    if (fifo.deferred === 0) {
      for (const pending of fifo.held.splice(0)) {
        ptyWrite(pending.reply, 'immediate(fifo-released)', pending.record)
      }
    }
  },
  onEmission: (emission) => {
    log('INGRESS->UI', `emit len=${emission.data.length}`, `"${escCapped(emission.data)}"`)
    scanRendererStream(emission.data)
  },
  ...(echoProbe ? { echoProbe } : {}),
  ...(echoSyncProbe ? { echoSyncProbe } : {})
})

/** Reply text -> records awaiting the delivery flush, so the trace can pair them up. */
const deferredByReply = new Map()

// VERBATIM from local-pty-provider.write() (src/main/providers/local-pty-provider.ts ~:1082).
function providerWrite(data, record) {
  if (extractOnlyCookedEchoSafeQueryReplies(data)) {
    const queue = deferredByReply.get(data) ?? []
    queue.push(record)
    deferredByReply.set(data, queue)
    if (ingress.answerLiveQueryReply(data)) {
      return true
    }
    queue.pop()
  }
  ptyWrite(data, 'immediate', record)
  return false
}

term.onData((data) => {
  rawOutput += data
  log('PTY->INGRESS', `read len=${data.length}`, `"${escCapped(data)}"`)
  ingress.accept(data)
})

let exitInfo = null
term.onExit((e) => {
  exitInfo = e
  log('PTY', 'exit', JSON.stringify(e))
})

// ------------------------------------------------- renderer (xterm) query -> reply model

/* oxlint-disable no-control-regex -- terminal query grammars are control sequences by definition */
// Anchored at an ESC, tried in order; first match wins. Reply values match xterm.js's.
const QUERY_GRAMMARS = [
  { name: 'OSC10', re: /^\x1b\]10;\?(\x07|\x1b\\)/, reply: (m) => `\x1b]10;rgb:ffff/ffff/ffff${m[1]}` },
  { name: 'OSC11', re: /^\x1b\]11;\?(\x07|\x1b\\)/, reply: (m) => `\x1b]11;rgb:1e1e/1e1e/1e1e${m[1]}` },
  { name: 'OSC12', re: /^\x1b\]12;\?(\x07|\x1b\\)/, reply: (m) => `\x1b]12;rgb:ffff/ffff/ffff${m[1]}` },
  { name: 'DECXCPR', re: /^\x1b\[\?6n/, reply: () => '\x1b[?1;1;1R' },
  { name: 'CPR', re: /^\x1b\[6n/, reply: () => '\x1b[1;1R' },
  { name: 'DSR-2031', re: /^\x1b\[\?996n/, reply: () => '\x1b[?997;1n' },
  { name: 'DSR', re: /^\x1b\[5n/, reply: () => '\x1b[0n' },
  { name: 'DA2', re: /^\x1b\[>0?c/, reply: () => '\x1b[>0;276;0c' },
  { name: 'DA3', re: /^\x1b\[=0?c/, reply: () => '\x1bP!|00000000\x1b\\' },
  { name: 'DA1', re: /^\x1b\[0?c/, reply: () => '\x1b[?1;2c' },
  { name: 'XTVERSION', re: /^\x1b\[>0?q/, reply: () => '\x1bP>|Orca(harness)\x1b\\' },
  { name: 'KITTY-FLAGS', re: /^\x1b\[\?u/, reply: () => '\x1b[?0u' },
  { name: 'XTWINOPS', re: /^\x1b\[(?:14|16|18)t/, reply: () => '\x1b[4;600;1200t' }
]
// A sequence still accumulating: no CSI final byte / no OSC-DCS terminator yet. Must be
// exact — a loose "short tail" rule silently eats complete queries at a chunk boundary.
const PARTIAL_QUERY_RE = new RegExp(
  `${[
    '^(?:\\u001b',
    '\\u001b\\[[?>=]?[0-9;]*',
    '\\u001b\\][0-9]*(?:;[^\\u0007\\u001b]*)?\\u001b?',
    '\\u001bP[^\\u001b]*\\u001b?'
  ].join('|')})$`
)
/* oxlint-enable no-control-regex */

let rendererTail = ''
let queryObservationSeq = 0

// Single chained timer, so a uniform delay stays strictly FIFO.
const uniformQueue = []
let uniformTimer = null
function drainUniformQueue() {
  if (uniformTimer || uniformQueue.length === 0) {
    return
  }
  const head = uniformQueue[0]
  uniformTimer = setTimeout(
    () => {
      uniformTimer = null
      uniformQueue.shift()
      ptyWrite(head.reply, `uniform+${UNIFORM_DELAY_MS}ms`, head.record)
      drainUniformQueue()
    },
    Math.max(0, head.dueAt - ms())
  )
}

function emitReply(name, reply) {
  const record = {
    observeSeq: ++queryObservationSeq,
    query: name,
    reply,
    observedAt: ms(),
    echoSafe: extractOnlyCookedEchoSafeQueryReplies(reply) !== null,
    writeSeq: null,
    writtenAt: null,
    route: null
  }
  replies.push(record)
  log('UI QUERY', `#${record.observeSeq} ${name}`, `-> reply "${esc(reply)}" echoSafe=${record.echoSafe}`)

  if (BYPASS_ECHO_SAFE) {
    ptyWrite(reply, 'immediate(bypass)', record)
    return
  }
  if (UNIFORM_DELAY_MS >= 0) {
    uniformQueue.push({ reply, record, dueAt: ms() + UNIFORM_DELAY_MS })
    drainUniformQueue()
    return
  }
  if (ORDER_FIFO) {
    if (record.echoSafe) {
      fifo.deferred += 1
      if (!providerWrite(reply, record)) {
        fifo.deferred = Math.max(0, fifo.deferred - 1)
      }
      return
    }
    if (fifo.deferred > 0) {
      log('FIFO', `hold #${record.observeSeq} ${name}`, `behind ${fifo.deferred} echo-safe reply(s)`)
      fifo.held.push({ reply, record })
      return
    }
    ptyWrite(reply, 'immediate', record)
    return
  }
  providerWrite(reply, record)
}

/** Scans the emitted stream left-to-right and answers strictly in the order seen. */
function scanRendererStream(chunk) {
  let buf = rendererTail + chunk
  rendererTail = ''
  let i = 0
  while (i < buf.length) {
    const at = buf.indexOf('\x1b', i)
    if (at === -1) {
      break
    }
    const rest = buf.slice(at)
    let matched = null
    for (const grammar of QUERY_GRAMMARS) {
      const m = grammar.re.exec(rest)
      if (m) {
        matched = { grammar, m }
        break
      }
    }
    if (matched) {
      emitReply(matched.grammar.name, matched.grammar.reply(matched.m))
      i = at + matched.m[0].length
      continue
    }
    if (PARTIAL_QUERY_RE.test(rest)) {
      rendererTail = rest // may still complete on the next emission
      return
    }
    i = at + 1
  }
}

// ---------------------------------------------------------------- driving

const sleep = (n) => new Promise((r) => setTimeout(r, n))
async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) {
      return true
    }
    await sleep(10)
  }
  log('HARNESS', 'TIMEOUT', `waiting for ${what}`)
  return false
}

try {
  await waitFor(() => rawOutput.includes(PROMPT_MARK), 15000, 'first prompt')
  await sleep(SETTLE_MS)

  if (TYPEAHEAD) {
    log('HARNESS', 'MARK', '--- `sleep 0.4` so the next line is typed ahead ---')
    ptyWrite('sleep 0.4\r', 'input')
    await sleep(TYPEAHEAD_AT_MS)
    log('HARNESS', 'MARK', '--- type-ahead: stdin-reading command + Enter while sleep owns the tty ---')
    ptyWrite(`${CHILD_CMD}\r`, 'input')
  } else {
    log('HARNESS', 'MARK', '--- typing stdin-reading command at an idle prompt ---')
    ptyWrite(`${CHILD_CMD}\r`, 'input')
  }
  await sleep(1500)

  log('HARNESS', 'MARK', '--- sending hello + Enter to the child ---')
  ptyWrite('hello\r', 'input')
  await sleep(1500)

  const childStdin = existsSync(LEAK_FILE) ? readFileSync(LEAK_FILE, 'utf8') : null
  const leaked = childStdin !== null && childStdin.includes('\x1b')
  const printedGot = (rawOutput.match(/GOT: '[^\r\n]*/) ?? [])[0] ?? null

  const answered = replies.filter((r) => r.writeSeq !== null)
  const inversions = []
  for (let a = 0; a < answered.length; a += 1) {
    for (let b = a + 1; b < answered.length; b += 1) {
      if (answered[a].writeSeq > answered[b].writeSeq) {
        inversions.push(`${answered[a].query}#${answered[a].observeSeq} after ${answered[b].query}#${answered[b].observeSeq}`)
      }
    }
  }
  const maxDeferMs = Math.max(
    0,
    ...answered.filter((r) => r.echoSafe).map((r) => r.writtenAt - r.observedAt)
  )

  log('HARNESS', 'RESULT mode', MODE)
  log('HARNESS', 'RESULT child-stdin-bytes', childStdin === null ? '<child never read>' : `"${esc(childStdin)}"`)
  log('HARNESS', 'RESULT printed-GOT-line', printedGot === null ? '<none>' : `"${esc(printedGot)}"`)
  log('HARNESS', 'RESULT leaked-escape-bytes-into-child-stdin', String(leaked))
  log('HARNESS', 'RESULT reply-order-inversions', `${inversions.length}${inversions.length ? ` [${inversions.slice(0, 8).join(', ')}]` : ''}`)
  log(
    'HARNESS',
    'RESULT replies',
    JSON.stringify({
      observed: replies.length,
      written: answered.length,
      echoSafe: replies.filter((r) => r.echoSafe).length,
      maxEchoSafeDeferMs: Number(maxDeferMs.toFixed(1))
    })
  )

  ptyWrite('exit\r', 'input')
  await waitFor(() => exitInfo !== null, 3000, 'shell exit')
  try {
    term.kill()
  } catch {}

  if (EMIT_JSON) {
    console.log(
      `\n__JSON__${JSON.stringify({
        mode: MODE,
        typeahead: TYPEAHEAD,
        leaked,
        childStdin,
        printedGot,
        inversions: inversions.length,
        inversionDetail: inversions,
        maxEchoSafeDeferMs: Number(maxDeferMs.toFixed(1)),
        replies: replies.map((r) => ({
          observeSeq: r.observeSeq,
          query: r.query,
          echoSafe: r.echoSafe,
          writeSeq: r.writeSeq,
          route: r.route,
          deferMs: r.writtenAt === null ? null : Number((r.writtenAt - r.observedAt).toFixed(1))
        }))
      })}`
    )
  }
} finally {
  rmSync(configHome, { recursive: true, force: true })
  rmSync(path.dirname(LEAK_FILE), { recursive: true, force: true })
}

process.exit(0)
