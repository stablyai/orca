/**
 * Real-fish regression for #13892: a terminal query reply Orca held back is overtaken
 * by the DA1 answer written later in the same turn, so fish's read sentinel hands the
 * tty to the child while the OSC 11 reply is still queued — and the CHILD READS IT.
 *
 * What is real here: node-pty running fish, `PtyStartupIngress`, `PtyStartupReplyDelivery`
 * and both echo probes, plus the host's own write gate
 * (`answerLiveQueryReply` — copied from local-pty-provider.write, which
 * is what decides whether a reply is deferred at all). Only the renderer is modelled: it
 * answers queries strictly in the order they appear in the stream, so any inversion the
 * child sees was produced by the delivery split and nothing else.
 *
 * The assertion is about a CHILD PROCESS'S STDIN, not the screen: a rendered-output check
 * passes while the bytes are still being eaten by the next `npx` / `brew` confirm prompt.
 * The child reads a full LINE because a leaked reply carries no newline, so a
 * once('data') child would report it alone whenever it happened to land in its own read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from './fish-binary-requirement'
import { PtyStartupIngress } from './pty-startup-ingress'

// Why fish 4: the DA1-sentinel handoff this measures lives in the 4.0 Rust tty_handoff.
const FISH = resolveFishBinary(4)
const itWithFish = FISH.available ? it : it.skip

const PROMPT_MARK = 'ORCA13892> '

/* oxlint-disable no-control-regex -- terminal query grammars are control sequences */
/** Anchored at an ESC, first match wins; reply values match xterm.js's. */
const QUERY_GRAMMARS = [
  {
    re: /^\x1b\]1[012];\?(\x07|\x1b\\)/,
    reply: (m: RegExpExecArray) => `\x1b]11;rgb:1e1e/1e1e/1e1e${m[1]}`
  },
  { re: /^\x1b\[\?6n/, reply: () => '\x1b[?1;1;1R' },
  { re: /^\x1b\[6n/, reply: () => '\x1b[1;1R' },
  { re: /^\x1b\[\?996n/, reply: () => '\x1b[?997;1n' },
  { re: /^\x1b\[>0?c/, reply: () => '\x1b[>0;276;0c' },
  { re: /^\x1b\[0?c/, reply: () => '\x1b[?1;2c' },
  { re: /^\x1b\[>0?q/, reply: () => '\x1bP>|Orca\x1b\\' },
  { re: /^\x1b\[\?u/, reply: () => '\x1b[?0u' }
] as const
/** Still accumulating: no CSI final byte and no OSC/DCS terminator yet. */
const PARTIAL_QUERY_RE =
  /^(?:\x1b|\x1b\[[?>=]?[0-9;]*|\x1b\][0-9]*(?:;[^\x07\x1b]*)?\x1b?|\x1bP[^\x1b]*\x1b?)$/
/* oxlint-enable no-control-regex */

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

describe('a held query reply never reaches the next child process (#13892)', () => {
  let configHome: string | null = null

  // Always runs, so the CI lane cannot report green with the regression below skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  // Same contract for the other half of the setup: a prebuilt node-pty has no echoState,
  // so the fix under test would be off and the regression below would run vacuously.

  afterEach(() => {
    if (configHome) {
      rmSync(configHome, { recursive: true, force: true })
      configHome = null
    }
  })

  itWithFish(
    'answers OSC 11 in the query turn so the reply cannot land in the child’s stdin',
    async () => {
      configHome = mkdtempSync(path.join(tmpdir(), 'orca-fish-13892-'))
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
      const childScript = path.join(configHome, 'read-stdin.mjs')
      writeFileSync(
        childScript,
        "let buffered = ''\n" +
          "process.stdin.on('data', (d) => {\n" +
          "  buffered += d.toString('utf8')\n" +
          "  if (!buffered.includes('\\n')) return\n" +
          "  process.stdout.write('CHILD-READ:' + JSON.stringify(buffered) + '\\n')\n" +
          '  process.exit(0)\n' +
          '})\n'
      )

      const nodePty = await import('node-pty')
      const term = nodePty.spawn(FISH.path as string, ['-l', '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: configHome,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: configHome,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: path.join(configHome, 'data'),
          ORCA_NODE_BIN: process.execPath,
          ORCA_CHILD_SCRIPT: childScript
        }
      })

      let rendered = ''
      const ingress = new PtyStartupIngress({
        ownerBackend: 'posix-pty',
        write: (data) => term.write(data),
        onEmission: (emission) => {
          rendered += emission.data
          answerQueriesInOrder(emission.data)
        }
      })

      // The host gate: cooked-echo-risk replies are written by the ingress with their
      // echo shapes armed; DA1/CPR stay on the host's own path, in call order.
      const hostWrite = (data: string): void => {
        if (ingress.answerLiveQueryReply(data)) {
          return
        }
        term.write(data)
      }

      let tail = ''
      let oscQueryCount = 0
      function answerQueriesInOrder(chunk: string): void {
        let buffer = tail + chunk
        tail = ''
        let index = 0
        while (index < buffer.length) {
          const at = buffer.indexOf('\x1b', index)
          if (at === -1) {
            return
          }
          const rest = buffer.slice(at)
          const grammar = QUERY_GRAMMARS.map((candidate) => ({
            candidate,
            match: candidate.re.exec(rest)
          })).find((entry) => entry.match)
          if (grammar?.match) {
            if (grammar.candidate === QUERY_GRAMMARS[0]) {
              oscQueryCount += 1
            }
            hostWrite(grammar.candidate.reply(grammar.match))
            index = at + grammar.match[0].length
            continue
          }
          if (PARTIAL_QUERY_RE.test(rest)) {
            tail = rest
            return
          }
          index = at + 1
        }
      }

      let exited = false
      term.onExit(() => {
        exited = true
      })
      term.onData((data) => ingress.accept(data))

      try {
        expect(await waitUntil(() => rendered.includes(PROMPT_MARK), 15_000)).toBe(true)
        await sleep(500)
        const oscQueriesBeforeHandoff = oscQueryCount

        // Type-ahead is the deterministic shape: queue the child's command while an
        // external command still owns the tty, so fish repaints its prompt (re-querying
        // OSC 11) and hands the tty over in the same breath.
        term.write('sleep 0.4\r')
        await sleep(150)
        term.write('"$ORCA_NODE_BIN" "$ORCA_CHILD_SCRIPT"\r')
        await sleep(1_500)
        expect(oscQueryCount).toBeGreaterThan(oscQueriesBeforeHandoff)

        const renderedBeforeChildInput = rendered.length
        term.write('hello\r')
        expect(
          await waitUntil(
            () => rendered.slice(renderedBeforeChildInput).includes('CHILD-READ:'),
            10_000
          )
        ).toBe(true)

        const childRead =
          rendered.slice(renderedBeforeChildInput).match(/CHILD-READ:[^\r\n]*/)?.[0] ?? ''
        // The merge-blocking assertion: the child's first LINE is what the user typed,
        // with no escape byte in front of it. Pre-fix this reads
        // `\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\hello\n`.
        expect(childRead).toBe('CHILD-READ:"hello\\n"')
      } finally {
        term.write('exit\r')
        await waitUntil(() => exited, 3_000)
        try {
          term.kill()
        } catch {
          // already gone
        }
      }
    },
    45_000
  )
})
