/**
 * The population the ECHO hold exists for: a program that queries while its tty is
 * still COOKED and only arms raw mode later (#12112).
 *
 * This is the guard that kills "drop the reply when the hold expires" — the querier is
 * blocked on the answer, so a dropped reply is a hung pane, not a cosmetic glitch. It is
 * also what proves #13892's same-turn fast path cannot fire here: the sync probe reads
 * `echoing` for as long as the querier stays cooked, so delivery behaves exactly as it
 * did before the fast path existed, and the answer still arrives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NODE_PTY_SOURCE_BUILD_HINT,
  nodePtyEchoStateRequirementViolation,
  resolveNodePtyEchoStateSupport
} from './node-pty-echo-state-requirement'
import { PtyStartupIngress } from './pty-startup-ingress'
import {
  createPtySlaveEchoProbe,
  createPtySlaveEchoSyncProbe,
  readPtySlavePath,
  type PtySlaveLineDisciplineEcho
} from './pty-slave-line-discipline-echo'
import { extractOnlyCookedEchoSafeQueryReplies } from './terminal-query-reply'

const OSC11_QUERY = '\x1b]11;?\x07'
const OSC11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'
const itOnPosix = process.platform === 'win32' ? it.skip : it

/** Queries OSC 11 while cooked, arms raw only after `rawDelayMs`, then reports what it read. */
const QUERIER_SOURCE = `
const rawDelayMs = Number(process.argv[2])
let received = ''
process.stdout.write(${JSON.stringify(OSC11_QUERY)})
setTimeout(() => {
  process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    received += chunk.toString('utf8')
    if (!received.includes('\\u0007') && !received.includes('\\u001b\\\\')) return
    process.stdout.write('QUERIER-GOT:' + JSON.stringify(received) + '\\n')
    process.exit(0)
  })
}, rawDelayMs)
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(10)
  }
  return false
}

describe('a cooked querier still gets its answer (#12112)', () => {
  let workDir: string | null = null

  // Always runs: a prebuilt node-pty has no echoState, so the fast path this suite
  // proves cannot fire would be off anyway and every case below would be vacuous.
  it('has the source-built node-pty this suite needs when CI requires one', async () => {
    const lookup = resolveNodePtyEchoStateSupport(await import('node-pty'))
    expect(nodePtyEchoStateRequirementViolation(lookup)).toBeNull()
  })

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true })
      workDir = null
    }
  })

  // 250ms outruns the 200ms probe budget, so the deadline flush answers instead of the
  // probe; both must still deliver. A raw-delay under the budget is the probe's own path.
  for (const rawDelayMs of [50, 250]) {
    itOnPosix(
      `delivers the reply to a querier that arms raw mode ${rawDelayMs}ms late`,
      async ({ skip }) => {
        const nodePty = await import('node-pty')
        // Skip rather than red a developer whose node_modules predates the patch; CI
        // sets ORCA_REQUIRE_NODE_PTY_ECHO_STATE=1 so the same state fails there.
        const echoStateSupport = resolveNodePtyEchoStateSupport(nodePty)
        if (!echoStateSupport.available) {
          skip(echoStateSupport.reason)
        }
        workDir = mkdtempSync(path.join(tmpdir(), 'orca-cooked-querier-'))
        const querierScript = path.join(workDir, 'cooked-querier.mjs')
        writeFileSync(querierScript, QUERIER_SOURCE)

        const term = nodePty.spawn(process.execPath, [querierScript, String(rawDelayMs)], {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: workDir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' }
        })

        const echoProbe = createPtySlaveEchoProbe(readPtySlavePath(term))
        const echoSyncProbe = createPtySlaveEchoSyncProbe(term)
        // Vacuity guard: a DEFINED probe proves nothing — the JS patch alone yields one
        // that answers 'unknown' forever. The `verdictsAtQuery` assertion below is the
        // real check; this one names the cause when the native binding is a prebuild.
        expect(
          echoSyncProbe?.(),
          `the sync probe gave no definite verdict, so #13892's same-turn reply is off. ${NODE_PTY_SOURCE_BUILD_HINT}`
        ).toMatch(/^(quiet|echoing)$/)

        let rendered = ''
        const verdictsAtQuery: PtySlaveLineDisciplineEcho[] = []
        const ingress = new PtyStartupIngress({
          ownerBackend: 'posix-pty',
          write: (data) => term.write(data),
          onEmission: (emission) => {
            rendered += emission.data
            if (!emission.data.includes(OSC11_QUERY)) {
              return
            }
            verdictsAtQuery.push(echoSyncProbe?.() ?? 'unknown')
            // The host gate, verbatim from local-pty-provider.write().
            if (extractOnlyCookedEchoSafeQueryReplies(OSC11_REPLY)) {
              ingress.answerLiveQueryReply(OSC11_REPLY)
            }
          },
          ...(echoProbe ? { echoProbe } : {}),
          ...(echoSyncProbe ? { echoSyncProbe } : {})
        })

        let exited = false
        term.onExit(() => {
          exited = true
        })
        term.onData((data) => ingress.accept(data))

        try {
          expect(await waitUntil(() => rendered.includes('QUERIER-GOT:'), 15_000)).toBe(true)
          // The querier was cooked when it asked, so the fast path was never eligible.
          expect(verdictsAtQuery).toEqual(['echoing'])
          expect(rendered).toContain('QUERIER-GOT:')
          expect(/QUERIER-GOT:"([^"]*)"/.exec(rendered)?.[1]).toContain('rgb:1e1e/1e1e/1e1e')
        } finally {
          await waitUntil(() => exited, 3_000)
          try {
            term.kill()
          } catch {
            // already gone
          }
        }
      },
      30_000
    )
  }
})
