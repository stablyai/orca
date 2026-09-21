// Phone-side relay connect benchmark. Replays the shipped mobile wire sequence against a real
// desktop through the production relay and prints per-phase timings, so a connect-speed change
// can be measured from the phone's vantage without building and instrumenting the mobile app.
//
//   pair:       node relay-phone-connect-bench.mjs pair [state.json] [--pairing-url-file=<path>]
//               Reads the orca://pair link from stdin, or from a 0600 file, so the live invite
//               token never lands in shell history or the process argument list. Dials the invite,
//               runs E2EE, pairing.provisionRelay + pairing.getEndpoints, and persists the resume
//               credential bundle to state.json (mode 0600, never commit it).
//   run:        node relay-phone-connect-bench.mjs run [state.json] [runs] [--resolve] [--gap=ms]
//               Steady-state resume dial N times (what a foreground reconnect does today).
//   foreground: node relay-phone-connect-bench.mjs foreground [state.json] [--hold=ms]
//                 [--resolve] [--force-redial]
//               Connect, idle the socket like a backgrounded phone, then measure whether the
//               retained socket still answers and what a full resume redial costs.
//
// See README.md for the dev-app recipe. Run from the repo root so `ws` / `tweetnacl` resolve.
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { b64url, PhoneE2EE, sha256, utf8 } from './phone-e2ee-v2-session.mjs'
import {
  classifyPublicHttpsOrigin,
  LIVE_ENV_VAR,
  parseArgs,
  refuse,
  requireBoundedInteger,
  requireLiveRun,
  resolvesToPublicAddress
} from './relay-bench-invocation.mjs'
import { readSecretFile, writeSecretFile } from './relay-bench-state-file.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')

const CAPABILITY_METHOD = 'runtime.clientCapabilities.update'
const DIAL_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 15_000
// Without this a director that accepts the connection and never answers blocks the benchmark
// before any dial or RPC deadline has started.
const RESOLVE_TIMEOUT_MS = 10_000
const DEFAULT_HOLD_MS = 45_000
const DEFAULT_STATE_PATH = '/tmp/relay-bench/state.json'
const MAX_RUNS = 1000
const MAX_DELAY_MS = 3_600_000

// ---------- one relay dial, phone-shaped ----------
// Resolves once e2ee_authenticated lands, with timings and an rpc() bound to the live socket.
export function dialRelay({
  cellUrl,
  relayHostId,
  credential,
  expectedKind,
  deviceToken,
  desktopPublicKeyB64
}) {
  return new Promise((resolve, reject) => {
    const timings = { start: performance.now() }
    const mark = (name) => (timings[name] = Math.round(performance.now() - timings.start))
    const url = new URL(cellUrl)
    url.protocol = 'wss:'
    url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
    const ws = new WebSocket(url.toString(), { perMessageDeflate: false })
    const e2ee = new PhoneE2EE(desktopPublicKeyB64, relayHostId)
    const handle = { timings, hello: null, closed: null }
    let stage = 'awaiting-hello'
    const pending = new Map()
    let nextId = 0
    let settled = false
    // Cleared on both outcomes: an uncleared 30 s timer keeps Node alive long after the last dial.
    const dialTimer = setTimeout(() => fail(new Error('dial timeout 30s')), DIAL_TIMEOUT_MS)
    // Settle, not just clear: an in-flight rpc() whose timer is dropped without a resolution
    // would await forever, which is exactly the hang the rpc timeout exists to prevent.
    const settlePending = (code) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
        waiter.res({ ok: false, error: { code } })
      }
      pending.clear()
    }
    const fail = (err) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(dialTimer)
      settlePending('dial-failed')
      try {
        ws.terminate()
      } catch {
        // already gone
      }
      reject(Object.assign(err, { timings, stage }))
    }
    handle.rpc = (method, params, timeoutMs = RPC_TIMEOUT_MS) =>
      new Promise((res, rej) => {
        // Without this the send would only surface as a 15 s rpc timeout, which would be
        // indistinguishable from a slow desktop in the foreground-hold measurement.
        if (ws.readyState !== WebSocket.OPEN) {
          rej(new Error(`socket not open (readyState ${ws.readyState})`))
          return
        }
        const id = `b-${++nextId}`
        const timer = setTimeout(() => {
          pending.delete(id)
          rej(new Error(`rpc timeout ${method}`))
        }, timeoutMs)
        pending.set(id, { res, timer })
        ws.send(e2ee.sealText(JSON.stringify({ id, method, params })))
      })
    handle.close = () => {
      clearTimeout(dialTimer)
      settlePending('closed')
      ws.terminate()
    }
    handle.socket = ws
    ws.on('open', () => {
      mark('wsOpen')
      ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential }))
      mark('relayAuthSent')
    })
    ws.on('message', (raw, isBinary) => {
      try {
        if (stage === 'awaiting-hello') {
          const hello = JSON.parse(raw.toString())
          handle.hello = hello
          mark('relayHello')
          if (!hello.ok) {
            throw new Error(`relay-hello rejected code=${hello.code}`)
          }
          if (hello.credentialKind !== expectedKind) {
            throw new Error(`credentialKind ${hello.credentialKind} != ${expectedKind}`)
          }
          stage = 'awaiting-ready'
          ws.send(JSON.stringify(e2ee.hello))
          mark('e2eeHelloSent')
          return
        }
        if (stage === 'awaiting-ready') {
          e2ee.acceptReady(JSON.parse(raw.toString()))
          mark('e2eeReady')
          stage = 'awaiting-authenticated'
          ws.send(
            e2ee.sealText(
              JSON.stringify({
                type: 'e2ee_auth',
                v: 2,
                transcriptHashB64: e2ee.transcriptHashB64,
                deviceToken
              })
            )
          )
          mark('e2eeAuthSent')
          return
        }
        if (isBinary) {
          e2ee.open(new Uint8Array(raw), 1)
          return
        }
        const text = e2ee.openText(raw.toString())
        if (stage === 'awaiting-authenticated') {
          const msg = JSON.parse(text)
          if (msg.type !== 'e2ee_authenticated') {
            throw new Error(`auth rejected: ${text.slice(0, 120)}`)
          }
          mark('e2eeAuthenticated')
          stage = 'ready'
          settled = true
          clearTimeout(dialTimer)
          resolve(handle)
          return
        }
        const msg = JSON.parse(text)
        const waiter = msg.id && pending.get(msg.id)
        if (waiter) {
          clearTimeout(waiter.timer)
          pending.delete(msg.id)
          waiter.res(msg)
        }
      } catch (err) {
        fail(err)
      }
    })
    ws.on('close', (code, reason) => {
      handle.closed = {
        code,
        reason: reason.toString(),
        atMs: Math.round(performance.now() - timings.start)
      }
      if (!settled) {
        fail(new Error(`closed ${code} ${reason.toString()}`))
        return
      }
      clearTimeout(dialTimer)
      settlePending('closed')
    })
    ws.on('error', (err) => fail(err))
  })
}

/** Parses the pairing link. Every failure here is operator input, so say which part was wrong. */
export function decodeOffer(pairingUrl) {
  if (typeof pairingUrl !== 'string' || !pairingUrl.startsWith('orca://pair')) {
    throw new Error('pairing link must look like orca://pair?code=<base64url>')
  }
  const marker = pairingUrl.indexOf('code=')
  if (marker === -1) {
    throw new Error('pairing link has no code= parameter')
  }
  const code = pairingUrl
    .slice(marker + 'code='.length)
    .split('&')[0]
    .trim()
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error('pairing link code is not base64url')
  }
  let offer
  try {
    offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
  } catch {
    throw new Error('pairing link code did not decode to JSON')
  }
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    throw new Error('pairing link code did not decode to an offer object')
  }
  return offer
}

async function resolveCell(relay, resumeToken) {
  const started = performance.now()
  try {
    const res = await fetch(`${relay.directorUrl}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: relay.relayHostId, resumeToken }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    })
    const body = await res.json().catch(() => null)
    return { ms: Math.round(performance.now() - started), status: res.status, body }
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError'
    return {
      ms: Math.round(performance.now() - started),
      status: null,
      error: timedOut ? `resolve timeout after ${RESOLVE_TIMEOUT_MS} ms` : err.message
    }
  }
}

// ---------- shared phases ----------
async function timedRpc(dial, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const started = performance.now()
  const res = await dial
    .rpc(method, params, timeoutMs)
    .catch((err) => ({ ok: false, error: { code: err.message } }))
  const entry = { ms: Math.round(performance.now() - started), ok: Boolean(res.ok) }
  if (!res.ok) {
    entry.error = res.error?.code
  }
  return { entry, res }
}

// What the shipped phone does before publishing 'connected': confirm resume, then a capability
// advisory, serialized. Then the UI gate's status.get, then the session's tabs.list +
// terminal.list for the first worktree, serialized.
async function runConnectedSequence(dial) {
  const rpc = {}
  const confirmReqId = `confirm-${b64url(nacl.randomBytes(16))}`
  const phases = [
    ['confirm', 'pairing.getEndpoints', { resumeConfirmReqId: confirmReqId }],
    ['capabilities', CAPABILITY_METHOD, { clientCapabilities: [] }],
    ['status.get', 'status.get', undefined],
    ['worktree.ps', 'worktree.ps', undefined]
  ]
  let firstWorktreeId = null
  for (const [label, method, params] of phases) {
    const { entry, res } = await timedRpc(dial, method, params)
    rpc[label] = entry
    if (label === 'worktree.ps' && res.ok) {
      const list = Array.isArray(res.result)
        ? res.result
        : (res.result?.worktrees ?? res.result?.items ?? [])
      entry.bytes = JSON.stringify(res.result).length
      firstWorktreeId = list[0]?.id ?? null
    }
  }
  if (firstWorktreeId) {
    for (const method of ['session.tabs.list', 'terminal.list']) {
      const { entry } = await timedRpc(dial, method, { worktree: `id:${firstWorktreeId}` })
      rpc[method] = entry
    }
  }
  return { rpc, firstWorktreeId }
}

function connectedMs(dial, rpc) {
  return dial.timings.e2eeAuthenticated + rpc.confirm.ms + rpc.capabilities.ms
}

async function resumeDial(state) {
  return dialRelay({
    cellUrl: state.relay.cellUrl,
    relayHostId: state.relay.relayHostId,
    credential: state.resumeToken,
    expectedKind: 'resume',
    deviceToken: state.deviceToken,
    desktopPublicKeyB64: state.desktopPublicKeyB64
  })
}

async function refreshCell(state, row) {
  const resolved = await resolveCell(state.relay, state.resumeToken)
  row.resolve = resolved
  if (resolved.status !== 200) {
    return
  }
  // The director names the next destination, so vet it the same way a probe origin is vetted:
  // the literal check first, then DNS, so a public-looking name that resolves into the operator's
  // network is refused before the resume credential is sent anywhere.
  const verdict = await vetCellUrl(resolved.body?.cellUrl)
  if (!verdict.ok) {
    row.resolve = { ...resolved, error: `director named an unusable cell: ${verdict.reason}` }
    return
  }
  state.relay = {
    ...state.relay,
    cellUrl: resolved.body.cellUrl,
    assignmentEpoch: resolved.body.assignmentEpoch
  }
}

export async function vetCellUrl(cellUrl, deps) {
  const verdict = classifyPublicHttpsOrigin(cellUrl)
  if (!verdict.ok) {
    return verdict
  }
  const resolved = await resolvesToPublicAddress(verdict.origin, deps)
  return resolved.ok ? verdict : resolved
}

function loadState(statePath) {
  const state = JSON.parse(readSecretFile(statePath))
  for (const field of ['relayHostId', 'cellUrl', 'directorUrl']) {
    if (!state.relay?.[field]) {
      throw new Error(`${statePath} has no relay.${field}; re-run pair`)
    }
  }
  for (const [label, value] of [
    ['relay.cellUrl', state.relay.cellUrl],
    ['relay.directorUrl', state.relay.directorUrl]
  ]) {
    const verdict = classifyPublicHttpsOrigin(value)
    if (!verdict.ok) {
      throw new Error(`${statePath} ${label} ${verdict.reason}`)
    }
  }
  return state
}

// ---------- commands ----------
async function pair(pairingUrl, statePath) {
  const offer = decodeOffer(pairingUrl)
  if (!offer.relay) {
    throw new Error('offer has no relay block (desktop relay offline?)')
  }
  const relay = offer.relay
  const verdict = await vetCellUrl(relay.cellUrl)
  if (!verdict.ok) {
    throw new Error(`offer names an unusable cell: ${verdict.reason}`)
  }
  const resumeToken = b64url(nacl.randomBytes(32))
  const resumeTokenHash = b64url(sha256(utf8(resumeToken)))
  const installReqId = `install-${b64url(nacl.randomBytes(12))}`
  console.log(`pair: dialing ${relay.cellUrl} host=${relay.relayHostId}`)
  const dial = await dialRelay({
    cellUrl: relay.cellUrl,
    relayHostId: relay.relayHostId,
    credential: relay.inviteToken,
    expectedKind: 'invite',
    deviceToken: offer.deviceToken,
    desktopPublicKeyB64: offer.publicKeyB64
  })
  console.log('invite dial timings', dial.timings)
  const provisionStarted = performance.now()
  const provision = await dial.rpc('pairing.provisionRelay', {
    reqId: installReqId,
    newResumeTokenHash: resumeTokenHash
  })
  const provisionMs = Math.round(performance.now() - provisionStarted)
  if (!provision.ok) {
    throw new Error(`provisionRelay failed: ${JSON.stringify(provision.error)}`)
  }
  const endpointsStarted = performance.now()
  const endpoints = await dial.rpc('pairing.getEndpoints', { installReqId })
  const endpointsMs = Math.round(performance.now() - endpointsStarted)
  if (!endpoints.ok || !endpoints.result.relay) {
    throw new Error(`getEndpoints failed: ${JSON.stringify(endpoints)}`)
  }
  console.log(`provisionRelay ${provisionMs} ms, getEndpoints ${endpointsMs} ms`)
  dial.close()
  const state = {
    relay: endpoints.result.relay,
    deviceToken: offer.deviceToken,
    desktopPublicKeyB64: offer.publicKeyB64,
    resumeToken,
    resumeCredentialVersion: provision.result.currentVersion,
    resumeExpiresAt: provision.result.resumeExpiresAt
  }
  // The desktop has already burned the provision request, so a failed write loses the credential.
  // writeSecretFile creates the parent directory and forces 0600 even on an existing file.
  writeSecretFile(statePath, JSON.stringify(state, null, 2))
  console.log(`saved ${statePath} (secret: never commit or share this file)`)
}

async function run(statePath, runs, opts) {
  const state = loadState(statePath)
  const rows = []
  for (let index = 0; index < runs; index++) {
    const row = { run: index }
    if (opts.resolve) {
      await refreshCell(state, row)
    }
    const started = performance.now()
    try {
      const dial = await resumeDial(state)
      row.dial = dial.timings
      row.acceptedAs = dial.hello.acceptedAs
      const { rpc } = await runConnectedSequence(dial)
      row.rpc = rpc
      row.totalToConnectedMs = connectedMs(dial, rpc)
      row.totalToFirstTerminalListMs = Math.round(performance.now() - started)
      dial.close()
    } catch (err) {
      row.error = err.message
      row.stage = err.stage
      row.dial = err.timings
    }
    rows.push(row)
    console.log(JSON.stringify(row))
    if (opts.gapMs) {
      await new Promise((res) => setTimeout(res, opts.gapMs))
    }
  }
  const ok = rows.filter((row) => !row.error)
  if (!ok.length) {
    return
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  console.log(
    `SUMMARY ${JSON.stringify({
      runs: rows.length,
      ok: ok.length,
      medianMs: {
        wsOpen: median(ok.map((row) => row.dial.wsOpen)),
        relayHello: median(ok.map((row) => row.dial.relayHello)),
        e2eeReady: median(ok.map((row) => row.dial.e2eeReady)),
        e2eeAuthenticated: median(ok.map((row) => row.dial.e2eeAuthenticated)),
        confirm: median(ok.map((row) => row.rpc.confirm.ms)),
        capabilities: median(ok.map((row) => row.rpc.capabilities.ms)),
        statusGet: median(ok.map((row) => row.rpc['status.get'].ms)),
        toConnected: median(ok.map((row) => row.totalToConnectedMs)),
        toTerminalList: median(ok.map((row) => row.totalToFirstTerminalListMs))
      }
    })}`
  )
}

// Simulates a backgrounded phone: connect, go silent for --hold, then find out whether the
// retained socket is still usable and what the fallback resume redial costs. The relay's client
// silence watchdog is ~105 s, so --hold=120000 is the interesting "crossed the watchdog" case.
async function foreground(statePath, opts) {
  const state = loadState(statePath)
  const row = { mode: 'foreground', holdMs: opts.holdMs }
  if (opts.resolve) {
    await refreshCell(state, row)
  }
  const dial = await resumeDial(state)
  row.dial = dial.timings
  row.acceptedAs = dial.hello.acceptedAs
  const { rpc } = await runConnectedSequence(dial)
  row.rpc = rpc
  row.totalToConnectedMs = connectedMs(dial, rpc)
  console.log(`holding socket idle for ${opts.holdMs} ms...`)
  await new Promise((res) => setTimeout(res, opts.holdMs))
  row.closedDuringHold = dial.closed
  const retained = await timedRpc(dial, 'status.get', undefined)
  row.retainedOk = retained.entry.ok
  row.retainedAnswerMs = retained.entry.ok ? retained.entry.ms : null
  if (!retained.entry.ok) {
    row.retainedError = retained.entry.error
  }
  dial.close()
  if (retained.entry.ok && !opts.forceRedial) {
    row.redialMs = null
    console.log(JSON.stringify(row))
    return
  }
  if (opts.resolve) {
    await refreshCell(state, row)
  }
  const redialStarted = performance.now()
  const second = await resumeDial(state)
  const secondSequence = await runConnectedSequence(second)
  row.redial = {
    dial: second.timings,
    rpc: secondSequence.rpc,
    totalToConnectedMs: connectedMs(second, secondSequence.rpc)
  }
  row.redialMs = Math.round(performance.now() - redialStarted)
  second.close()
  console.log(JSON.stringify(row))
}

// ---------- cli ----------
const USAGE = [
  `every command dials a real desktop over the production relay, so prefix it with ${LIVE_ENV_VAR}=1:`,
  '  pair [state.json] [--pairing-url-file=<path>]',
  '      reads the orca://pair link from stdin unless --pairing-url-file names a 0600 file, so',
  '      the live invite token never enters shell history or the process argument list',
  '  run [state.json] [runs] [--resolve] [--gap=ms]',
  '  foreground [state.json] [--hold=ms] [--resolve] [--force-redial]'
].join('\n')

function requireStatePath(value) {
  if (value === undefined) {
    return DEFAULT_STATE_PATH
  }
  if (value.startsWith('orca://')) {
    refuse(
      `the pairing link must not appear in the command line: pipe it on stdin or pass --pairing-url-file=<path>.\n${USAGE}`
    )
  }
  if (!value.trim()) {
    refuse(`state path must not be empty.\n${USAGE}`)
  }
  return value
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    return ''
  }
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readPairingUrl(options) {
  const file = options.get('--pairing-url-file')
  const raw = (file ? readSecretFile(file) : await readStdinText()).trim()
  if (!raw) {
    refuse(
      file
        ? `${file} is empty; it must hold the orca://pair link.\n${USAGE}`
        : `no pairing link on stdin. pipe it in, or pass --pairing-url-file=<path>.\n${USAGE}`
    )
  }
  return raw
}

function refuseExtraPositionals(positional, allowed) {
  if (positional.length > allowed) {
    refuse(`unexpected argument ${JSON.stringify(positional[allowed])}.\n${USAGE}`)
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv
  const { flags, options, positional } = parseArgs(rest)
  if (cmd === 'pair' || cmd === 'run' || cmd === 'foreground') {
    requireLiveRun(`${LIVE_ENV_VAR}=1 node relay-phone-connect-bench.mjs ${cmd} ...`)
  }
  if (cmd === 'pair') {
    refuseExtraPositionals(positional, 1)
    const statePath = requireStatePath(positional[0])
    await pair(await readPairingUrl(options), statePath)
    return
  }
  if (cmd === 'run') {
    refuseExtraPositionals(positional, 2)
    await run(
      requireStatePath(positional[0]),
      requireBoundedInteger(positional[1], 'runs', USAGE, { min: 1, max: MAX_RUNS, fallback: 5 }),
      {
        resolve: flags.has('--resolve'),
        gapMs: requireBoundedInteger(options.get('--gap'), '--gap', USAGE, {
          min: 0,
          max: MAX_DELAY_MS,
          fallback: 0
        })
      }
    )
    return
  }
  if (cmd === 'foreground') {
    refuseExtraPositionals(positional, 1)
    await foreground(requireStatePath(positional[0]), {
      resolve: flags.has('--resolve'),
      forceRedial: flags.has('--force-redial'),
      holdMs: requireBoundedInteger(options.get('--hold'), '--hold', USAGE, {
        min: 0,
        max: MAX_DELAY_MS,
        fallback: DEFAULT_HOLD_MS
      })
    })
    return
  }
  console.error(USAGE)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A bad state file or a refused destination is operator input, not a crash; say what is wrong
  // without spilling the credential-bearing stack.
  await main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}
