import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createMockDispatcher,
  createTestPtyHandler
} from '../../src/relay/pty-handler-test-harness.ts'
import {
  captureDescendantSnapshot,
  readProcessTable
} from '../../src/main/pty-descendant-termination.ts'
import { runProcess } from '../../src/shared/child-process/run-process.ts'

const binary = process.env.ORCA_OMP_PROBE_BINARY
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

it.skipIf(!binary || process.platform === 'win32')(
  'closes actual OMP detached tools through the relay host',
  async () => {
    const fixtures = join(process.cwd(), '.bench-fixtures')
    mkdirSync(fixtures, { recursive: true })
    const output = mkdtempSync(join(fixtures, 'omp-relay-close-'))
    const home = mkdtempSync(join(tmpdir(), 'orca-omp-relay-close-home-'))
    const agentHome = join(home, 'agent')
    mkdirSync(agentHome)
    const config = join(home, 'probe.yml')
    writeFileSync(
      config,
      'startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\n'
    )
    const dispatcher = createMockDispatcher()
    let transcript = ''
    dispatcher.notify = (method, params) => {
      if (method === 'pty.data' && typeof params?.data === 'string') {
        transcript = (transcript + params.data).slice(-131072)
      }
    }
    const handler = createTestPtyHandler(dispatcher)
    let snapshot
    let id
    try {
      const spawned = await dispatcher.callRequest('pty.spawn', {
        cwd: home,
        cols: 120,
        rows: 35,
        env: {
          HOME: home,
          USERPROFILE: home,
          ZDOTDIR: home,
          ORCA_ORIG_ZDOTDIR: home,
          SHELL:
            process.env.ORCA_OMP_PROBE_SHELL ??
            (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_DATA_HOME: join(home, 'data'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_STATE_HOME: join(home, 'state'),
          OMP_CODING_AGENT_DIR: agentHome,
          PI_CODING_AGENT_DIR: agentHome,
          OMP_PROFILE: '',
          PI_PROFILE: '',
          PI_CONFIG_DIR: '.omp',
          PI_CONFIG_FILES: '',
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_PANE_KEY: 'omp-relay-probe:owned-leaf',
          ORCA_TAB_ID: 'omp-relay-probe'
        },
        envToDelete: ['BASH_ENV', 'ENV', 'ORCA_OMP_STATUS_EXTENSION', 'ORCA_PI_STATUS_EXTENSION']
      })
      id = spawned.id
      const [entry] = JSON.parse(await dispatcher.callRequest('pty.serialize', { ids: [id] }))
      snapshot = await captureDescendantSnapshot(entry.pid)
      expect(snapshot?.root?.pid).toBe(entry.pid)
      dispatcher.callNotification('pty.data', {
        id,
        data: `${quote(binary)} --no-session --config ${quote(config)}\r`
      })
      await pause(5000)
      dispatcher.callNotification('pty.data', { id, data: '! /bin/sleep 120\r' })
      for (let attempt = 0; attempt < 25; attempt++) {
        await pause(200)
        snapshot = await captureDescendantSnapshot(entry.pid)
        if (snapshot?.descendants.length > 1) {
          break
        }
      }
      expect(snapshot?.descendants.length).toBeGreaterThan(1)
      const pids = [entry.pid, ...snapshot.descendants.map((row) => row.pid)]
      const rows = async () => {
        const result = await runProcess({
          program: 'ps',
          args: ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,stat=,comm='],
          maxOutputBytes: 16000
        })
        expect(result.timedOut).toBe(false)
        expect(result.signal).toBeNull()
        expect(result.stderr.trim()).toBe('')
        expect([0, 1]).toContain(result.code)
        if (result.code === 1) {
          expect(result.stdout.trim()).toBe('')
        }
        return result.stdout.trim()
      }
      const before = await rows()
      expect(before).toContain('omp')
      expect(before).toContain('sleep')
      await dispatcher.callRequest('pty.shutdown', {
        id,
        immediate: true,
        expectedIncarnationId: spawned.incarnationId
      })
      await pause(6000)
      const after = await rows()
      writeFileSync(
        join(output, 'report.json'),
        JSON.stringify({ backend: 'relay-host', before, after, pid: entry.pid, id, home }, null, 2)
      )
      writeFileSync(join(output, 'transcript.txt'), transcript)
      console.log(output)
      expect(after).toBe('')
    } finally {
      if (snapshot) {
        const current = await readProcessTable()
        const owned = [
          ...snapshot.descendants,
          ...(snapshot.root ? [{ ...snapshot.root, pgid: snapshot.rootPgid }] : [])
        ]
        for (const row of current.rows) {
          if (
            owned.some(
              (known) =>
                known.pid === row.pid &&
                known.startedAt === row.startedAt &&
                known.pgid === row.pgid
            )
          ) {
            try {
              process.kill(row.pid, 'SIGKILL')
            } catch {}
          }
        }
      }
      await handler.dispose({ waitForPhysicalExit: false })
      rmSync(home, { recursive: true, force: true })
    }
  },
  45000
)
