#!/usr/bin/env node
/**
 * Ground-truth repro harness for issue #9993: color-scheme (CSI ?997;1n) replies
 * leaking into a child process' stdin under fish.
 *
 * Simulates Orca's terminal pipeline around a REAL fish shell:
 *   node-pty  ->  scanMode2031ReplyDecision() (the real scanner from
 *                 src/shared/terminal-color-scheme-protocol.ts)
 *             ->  reply `CSI ?997;1n` written back to the PTY, optionally after
 *                 a delay that models the renderer IPC round-trip.
 *
 * Requires Node >= 22.18 (native TypeScript type stripping) so the real .ts
 * scanner can be imported without a build step.
 *
 * Usage:
 *   node tests/tools/fish-mode2031-repro/capture-fish-mode2031-trace.mjs [options]
 *
 *   --delay=<ms>        reply delay; 0 = synchronous in-process (default 0)
 *   --shell=<path>      fish binary (default /opt/homebrew/bin/fish)
 *   --user-config       use the caller's real fish config (Tide etc.) instead of
 *                       an isolated minimal config
 *   --prompt-cmd        add an external command substitution to fish_prompt, so
 *                       the prompt itself forces extra tty handoffs
 *   --no-probes         do NOT answer DA1/DA2/CPR/XTVERSION/OSC 10/11 (fish then
 *                       stalls 10s on its DA1 wait)
 *   --accept-delay=<ms> gap between typing the command and pressing Enter (300)
 *   --paste             send command + Enter in a single write (paste-like)
 *   --no-reply          never answer 2031 (control run)
 *   --json              append a machine-readable summary
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const pty = require(path.join(REPO_ROOT, 'node_modules/node-pty'))
const { INITIAL_MODE_2031_REPLY_SCAN_STATE, mode2031SequenceFor, scanMode2031ReplyDecision } =
  await import(path.join(REPO_ROOT, 'src/shared/terminal-color-scheme-protocol.ts'))

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const REPLY_DELAY_MS = Number(opt('delay', '0'))
const SHELL = opt('shell', '/opt/homebrew/bin/fish')
const USE_USER_CONFIG = flag('user-config')
const ANSWER_PROBES = !flag('no-probes')
const REPLY_ENABLED = !flag('no-reply')
const EMIT_JSON = flag('json')
const ACCEPT_DELAY_MS = Number(opt('accept-delay', '300'))
const PASTE = flag('paste')
const PROMPT_CMD = flag('prompt-cmd')
const TYPEAHEAD = flag('typeahead')
const TYPEAHEAD_AT_MS = Number(opt('typeahead-at', '150'))
const SETTLE_MS = Number(opt('settle', '400'))

const PROMPT_MARK = 'HARNESS> '
const CHILD_CMD = `python3 -c 'import sys; d=sys.stdin.readline(); print("GOT:", repr(d))'`

// ---------------------------------------------------------------- tracing

const t0 = process.hrtime.bigint()
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6
const stamp = () => ms().toFixed(3).padStart(10, ' ')

const trace = []
function log(dir, label, detail) {
  const line = `[${stamp()}ms] ${dir.padEnd(12)} ${label}${detail ? ` ${detail}` : ''}`
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
    } else if (c === 0x9b) {
      out += '\\x9b'
    } else {
      out += ch
    }
  }
  return out
}

const CHUNK_PRINT_CAP = 1200
function escCapped(s) {
  const e = esc(s)
  return e.length > CHUNK_PRINT_CAP
    ? `${e.slice(0, CHUNK_PRINT_CAP)}…<+${e.length - CHUNK_PRINT_CAP} esc-chars>`
    : e
}

// ---------------------------------------------------------------- fish config

let configHome = null
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }
delete env.FISH_HISTORY
if (!USE_USER_CONFIG) {
  configHome = mkdtempSync(path.join(tmpdir(), 'fish-2031-'))
  mkdirSync(path.join(configHome, 'fish'), { recursive: true })
  // Plain prompt: no Tide, no async prompt machinery. fish core still toggles
  // DEC 2031 in tty_handoff.rs regardless of the prompt.
  const promptBody = PROMPT_CMD
    ? `set -l __x (/bin/echo -n ok); printf '${PROMPT_MARK}'`
    : `printf '${PROMPT_MARK}'`
  writeFileSync(
    path.join(configHome, 'fish/config.fish'),
    [
      'set -g fish_greeting ""',
      `function fish_prompt; ${promptBody}; end`,
      'function fish_right_prompt; end',
      ''
    ].join('\n')
  )
  env.XDG_CONFIG_HOME = configHome
  env.XDG_DATA_HOME = path.join(configHome, 'data')
}

// ---------------------------------------------------------------- pty

log(
  'HARNESS',
  'config',
  JSON.stringify({
    shell: SHELL,
    replyDelayMs: REPLY_DELAY_MS,
    acceptDelayMs: ACCEPT_DELAY_MS,
    paste: PASTE,
    promptCmd: PROMPT_CMD,
    replyEnabled: REPLY_ENABLED,
    userConfig: USE_USER_CONFIG,
    answerProbes: ANSWER_PROBES,
    xdgConfigHome: configHome
  })
)

const term = pty.spawn(SHELL, ['-l', '-i'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: REPO_ROOT,
  env
})

let scanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
let all = ''
let replyCount = 0
const replyEvents = []
const decisionEvents = []
let phase = 'boot'
let chunkSeq = 0
let lastDecision = null
let staleReplyCount = 0

function ptyWrite(bytes, label) {
  log('HARNESS->PTY', label, `"${esc(bytes)}"`)
  term.write(bytes)
}

function sendMode2031Reply(reason) {
  replyCount += 1
  // Stale = the scanner has already seen fish's `CSI ?2031l` (tty handed to a child)
  // by the time this reply actually reaches the PTY. That reply lands in the child's stdin.
  const stale = lastDecision === 'unsubscribed'
  if (stale) {
    staleReplyCount += 1
  }
  replyEvents.push({ at: ms(), phase, reason, delayMs: REPLY_DELAY_MS, stale })
  ptyWrite(
    mode2031SequenceFor('dark'),
    `reply#${replyCount} CSI ?997;1n (${reason}, phase=${phase}${stale ? ', STALE: fish already sent ?2031l' : ''})`
  )
}

// Modest emulation of the other terminal replies fish may probe for.
function answerProbes(data) {
  if (!ANSWER_PROBES) {
    return
  }
  // oxlint-disable no-control-regex -- terminal escape sequences require control chars
  if (/\x1b\[(?:0)?c/.test(data)) {
    ptyWrite('\x1b[?62;4;6;22c', 'probe reply DA1')
  }
  if (/\x1b\[>(?:0)?c/.test(data)) {
    ptyWrite('\x1b[>1;95;0c', 'probe reply DA2')
  }
  if (/\x1b\[(?:6n)/.test(data)) {
    ptyWrite('\x1b[1;1R', 'probe reply CPR')
  }
  if (/\x1b\[>q/.test(data)) {
    ptyWrite('\x1bP>|orca-harness(1)\x1b\\', 'probe reply XTVERSION')
  }
  if (/\x1b\]10;\?/.test(data)) {
    ptyWrite('\x1b]10;rgb:ffff/ffff/ffff\x1b\\', 'probe reply OSC 10')
  }
  if (/\x1b\]11;\?/.test(data)) {
    ptyWrite('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', 'probe reply OSC 11')
  }
  // oxlint-enable no-control-regex
}

term.onData((data) => {
  const seq = ++chunkSeq
  all += data
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
  const mode2031ToggleRe = /\x1b\[\?([0-9;]+)([hl])/g
  const toggles = [...data.matchAll(mode2031ToggleRe)]
    .filter((m) => m[1].split(';').some((p) => Number(p) === 2031))
    .map((m) => `?2031${m[2]}`)
  log(
    'PTY->SCANNER',
    `chunk#${seq} len=${data.length}${toggles.length ? ` toggles=[${toggles.join(',')}]` : ''}`,
    `"${escCapped(data)}"`
  )

  const before = scanState
  const result = scanMode2031ReplyDecision(scanState, data)
  scanState = result.state
  if (result.decision || before.pendingSubscribe !== scanState.pendingSubscribe || scanState.tail) {
    log(
      'SCANNER',
      `chunk#${seq} decision=${result.decision ?? 'null'}`,
      `state={tail:"${esc(scanState.tail)}",pendingSubscribe:${scanState.pendingSubscribe}}`
    )
  }
  if (result.decision) {
    lastDecision = result.decision
    decisionEvents.push({ at: ms(), seq, decision: result.decision, phase })
  }

  if (REPLY_ENABLED && result.decision === 'subscribed') {
    if (REPLY_DELAY_MS <= 0) {
      sendMode2031Reply(`chunk#${seq} sync`)
    } else {
      setTimeout(() => sendMode2031Reply(`chunk#${seq} +${REPLY_DELAY_MS}ms`), REPLY_DELAY_MS)
    }
  }
  answerProbes(data)
})

let exitInfo = null
term.onExit((e) => {
  exitInfo = e
  log('PTY', 'exit', JSON.stringify(e))
})

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

const countPrompts = () => all.split(PROMPT_MARK).length - 1

try {
  phase = 'boot'
  await waitFor(() => all.includes(PROMPT_MARK), 15000, 'first prompt')
  await sleep(SETTLE_MS)

  let promptsBeforeAccept
  let repliesBeforeAccept
  let decisionsBeforeAccept
  let outLenBeforeAccept

  if (TYPEAHEAD) {
    // Most realistic leak window: queue the command while an external command
    // still owns the tty. fish redraws the prompt (`CSI ?2031h`) and consumes the
    // buffered line in the same breath, so the handoff to the child happens
    // sub-millisecond after the subscribe.
    phase = 'pre-command'
    log('HARNESS', 'MARK', '--- running `sleep 0.4` so the next line is typed ahead ---')
    ptyWrite('sleep 0.4\r', 'pre-command')
    await sleep(TYPEAHEAD_AT_MS)

    promptsBeforeAccept = countPrompts()
    repliesBeforeAccept = replyCount
    decisionsBeforeAccept = decisionEvents.length
    outLenBeforeAccept = all.length

    phase = 'prompt-accept'
    log('HARNESS', 'MARK', '--- type-ahead: command + Enter while sleep still owns the tty ---')
    ptyWrite(`${CHILD_CMD}\r`, 'typeahead command + Enter')
  } else if (PASTE) {
    promptsBeforeAccept = countPrompts()
    repliesBeforeAccept = replyCount
    decisionsBeforeAccept = decisionEvents.length
    outLenBeforeAccept = all.length
    phase = 'prompt-accept'
    log('HARNESS', 'MARK', '--- pasting command + Enter in one write (prompt-accept) ---')
    ptyWrite(`${CHILD_CMD}\r`, 'paste command + Enter')
  } else {
    phase = 'type-command'
    log('HARNESS', 'MARK', '--- typing child command (no Enter yet) ---')
    ptyWrite(CHILD_CMD, 'type command')
    await sleep(ACCEPT_DELAY_MS)

    promptsBeforeAccept = countPrompts()
    repliesBeforeAccept = replyCount
    decisionsBeforeAccept = decisionEvents.length
    outLenBeforeAccept = all.length

    phase = 'prompt-accept'
    log('HARNESS', 'MARK', '--- pressing Enter (prompt-accept -> tty handoff to child) ---')
    ptyWrite('\r', 'Enter')
  }
  await sleep(1200)

  const repliesDuringAccept = replyCount - repliesBeforeAccept
  const decisionsDuringAccept = decisionEvents.length - decisionsBeforeAccept

  phase = 'child-stdin'
  log('HARNESS', 'MARK', '--- typing hello + Enter into the child ---')
  ptyWrite('hello\r', 'child stdin')
  await sleep(1500)

  phase = 'teardown'
  // python's repr renders ESC as the 4 literal chars \x1b, so match on the printed form.
  const gotLine = (all.slice(outLenBeforeAccept).match(/GOT: '[^\r\n]*/) ?? [])[0] ?? null
  log('HARNESS', 'RESULT GOT-line', gotLine === null ? '<none captured>' : `"${esc(gotLine)}"`)
  const leaked = gotLine !== null && /\\x1b|\\033|\\u001b/.test(gotLine)
  const leaked997 = gotLine !== null && gotLine.includes('997;1n')
  log('HARNESS', 'RESULT leaked-escape-bytes-into-stdin', String(leaked))
  log('HARNESS', 'RESULT leaked-CSI-997-1n-into-stdin', String(leaked997))
  log(
    'HARNESS',
    'RESULT replies',
    JSON.stringify({
      total: replyCount,
      duringPromptAccept: repliesDuringAccept,
      decisionsDuringPromptAccept: decisionsDuringAccept,
      staleReplies: staleReplyCount,
      promptsBeforeAccept
    })
  )

  ptyWrite('exit\r', 'exit')
  await waitFor(() => exitInfo !== null, 3000, 'shell exit')
  try {
    term.kill()
  } catch {}

  if (EMIT_JSON) {
    console.log(
      `\n__JSON__${JSON.stringify({
        delayMs: REPLY_DELAY_MS,
        mode: TYPEAHEAD ? 'typeahead' : PASTE ? 'paste' : 'typed',
        acceptDelayMs: ACCEPT_DELAY_MS,
        promptCmd: PROMPT_CMD,
        replyEnabled: REPLY_ENABLED,
        userConfig: USE_USER_CONFIG,
        answerProbes: ANSWER_PROBES,
        gotLine,
        leaked,
        leaked997,
        totalReplies: replyCount,
        staleReplies: staleReplyCount,
        repliesDuringPromptAccept: repliesDuringAccept,
        decisions: decisionEvents,
        replies: replyEvents
      })}`
    )
  }
} finally {
  if (configHome) {
    rmSync(configHome, { recursive: true, force: true })
  }
}

process.exit(0)
