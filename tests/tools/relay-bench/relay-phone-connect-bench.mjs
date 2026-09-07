// Phone-side relay connect benchmark. Replays the shipped mobile wire sequence against a real
// desktop through the production relay and prints per-phase timings, so a connect-speed change
// can be measured from the phone's vantage without building and instrumenting the mobile app.
//
//   pair:       node relay-phone-connect-bench.mjs pair '<orca://pair?code=...>' [state.json]
//               Invite dial over the relay, E2EE, pairing.provisionRelay + pairing.getEndpoints.
//               Persists the resume credential bundle to state.json (mode 0600, never commit it).
//   run:        node relay-phone-connect-bench.mjs run [state.json] [runs] [--resolve] [--gap=ms]
//               Steady-state resume dial N times (what a foreground reconnect does today).
//   foreground: node relay-phone-connect-bench.mjs foreground [state.json] [--hold=ms]
//                 [--resolve] [--force-redial]
//               Connect, idle the socket like a backgrounded phone, then measure whether the
//               retained socket still answers and what a full resume redial costs.
//
// See README.md for the dev-app recipe. Run from the repo root so `ws` / `tweetnacl` resolve.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { b64url, PhoneE2EE, sha256, utf8 } from './phone-e2ee-v2-session.mjs'
import { LIVE_ENV_VAR, parseArgs, requireLiveRun } from './relay-bench-invocation.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const nacl = require('tweetnacl')

const CAPABILITY_METHOD = 'runtime.clientCapabilities.update'
const DIAL_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 15_000
const DEFAULT_HOLD_MS = 45_000
const DEFAULT_STATE_PATH = '/tmp/relay-bench/state.json'

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
    const fail = (err) => {
      if (settled) {
        return
      }
      settled = true
      try {
        ws.terminate()
      } catch {
        // already gone
      }
      reject(Object.assign(err, { timings, stage }))
    }
    handle.rpc = (method, params, timeoutMs = DIAL_TIMEOUT_MS) =>
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
    handle.close = () => ws.terminate()
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
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
        waiter.res({ ok: false, error: { code: 'closed' } })
      }
      pending.clear()
    })
    ws.on('error', (err) => fail(err))
    setTimeout(() => fail(new Error('dial timeout 30s')), DIAL_TIMEOUT_MS)
  })
}

function decodeOffer(pairingUrl) {
  const code = pairingUrl.split('code=')[1]
  return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
}

async function resolveCell(relay, resumeToken) {
  const started = performance.now()
  const res = await fetch(`${relay.directorUrl}/v1/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId: relay.relayHostId, resumeToken })
  })
  const body = await res.json().catch(() => null)
  return { ms: Math.round(performance.now() - started), status: res.status, body }
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
  if (resolved.status === 200) {
    state.relay = {
      ...state.relay,
      cellUrl: resolved.body.cellUrl,
      assignmentEpoch: resolved.body.assignmentEpoch
    }
  }
}

function loadState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

// ---------- commands ----------
async function pair(pairingUrl, statePath) {
  const offer = decodeOffer(pairingUrl)
  if (!offer.relay) {
    throw new Error('offer has no relay block (desktop relay offline?)')
  }
  const relay = offer.relay
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
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
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
  "  pair '<orca://pair?code=...>' [state.json]",
  '  run [state.json] [runs] [--resolve] [--gap=ms]',
  '  foreground [state.json] [--hold=ms] [--resolve] [--force-redial]'
].join('\n')

async function main(argv) {
  const [cmd, ...rest] = argv
  const { flags, options, positional } = parseArgs(rest)
  if (cmd === 'pair' || cmd === 'run' || cmd === 'foreground') {
    requireLiveRun(`${LIVE_ENV_VAR}=1 node relay-phone-connect-bench.mjs ${cmd} ...`)
  }
  if (cmd === 'pair') {
    await pair(positional[0], positional[1] ?? DEFAULT_STATE_PATH)
    return
  }
  if (cmd === 'run') {
    await run(positional[0] ?? DEFAULT_STATE_PATH, Number(positional[1] ?? 5), {
      resolve: flags.has('--resolve'),
      gapMs: Number(options.get('--gap') ?? 0)
    })
    return
  }
  if (cmd === 'foreground') {
    await foreground(positional[0] ?? DEFAULT_STATE_PATH, {
      resolve: flags.has('--resolve'),
      forceRedial: flags.has('--force-redial'),
      holdMs: Number(options.get('--hold') ?? DEFAULT_HOLD_MS)
    })
    return
  }
  console.error(USAGE)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
