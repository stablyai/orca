import assert from 'node:assert/strict'
import { spawnBunPty } from '../../src/main/daemon/pty-subprocess/bun-pty-process.ts'
import { Session } from '../../src/main/daemon/session.ts'
import { TerminalSessionTeardown } from '../../src/main/daemon/terminal-session-teardown.ts'
import { createDaemonPtySubprocessHandle } from '../../src/main/daemon/pty-subprocess/subprocess-handle.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '../../src/shared/child-process/run-process.ts'
import {
  captureDescendantSnapshot,
  readProcessTable
} from '../../src/main/pty-descendant-termination.ts'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const ownedPidRows = async (pids) => {
  const result = await runProcess({
    program: 'ps',
    args: ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,stat=,args='],
    maxOutputBytes: 16000
  })
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.equal(result.stderr.trim(), '')
  assert.ok([0, 1].includes(result.code))
  if (result.code === 1) {
    assert.equal(result.stdout.trim(), '')
  }
  return result.stdout.trim()
}
export async function runOmpCloseProbe({ binary, externalTool, shell: requestedShell }) {
  const fixtures = join(process.cwd(), '.bench-fixtures')
  mkdirSync(fixtures, { recursive: true })
  const output = mkdtempSync(join(fixtures, 'omp-close-'))
  const report = []
  for (const launch of ['recognized', 'typed']) {
    const close = 'explicit'
    const home = mkdtempSync(join(tmpdir(), 'orca-omp-close-home-'))
    const agentHome = join(home, 'agent')
    mkdirSync(agentHome)
    const config = join(home, 'probe.yml')
    writeFileSync(
      config,
      'startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\n'
    )
    const id = `${launch}-${close}`
    let transcript = ''
    let nativeExit = null
    const shell = requestedShell ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const shellArgs = shell.endsWith('zsh') ? ['-f', '-i'] : ['--noprofile', '--norc', '-i']
    const proc = spawnBunPty({
      file: shell,
      args: shellArgs,
      cols: 120,
      rows: 35,
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ZDOTDIR: home,
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
        ORCA_BACKGROUND_LAUNCH: '1'
      }
    })
    const daemonSession = new Session({
      sessionId: id,
      cols: 120,
      rows: 35,
      shellReadySupported: false,
      ...(launch === 'recognized' ? { launchAgent: 'omp' } : {}),
      subprocess: createDaemonPtySubprocessHandle({
        process: proc,
        shellPath: shell,
        spawnCwd: home,
        env: process.env,
        startupCommandDeliveredInShellArgs: false,
        reportsChildExitStatus: true,
        sessionId: id,
        startupAgentRecognition: null
      })
    })
    proc.onData((data) => {
      transcript = (transcript + data).slice(-131072)
    })
    const exitSubscription = proc.onExit((event) => {
      nativeExit = event
    })
    let snapshot
    try {
      proc.write(`${quote(binary)} --no-session --config ${quote(config)}\r`)
      await delay(5000)
      snapshot = await captureDescendantSnapshot(proc.pid)
      assert.ok(snapshot?.descendants.length > 0)
      if (externalTool) {
        proc.write('! /bin/sleep 120\r')
        for (let attempt = 0; attempt < 25; attempt++) {
          await delay(200)
          snapshot = await captureDescendantSnapshot(proc.pid)
          if (snapshot?.descendants.length > 1) {
            break
          }
        }
        assert.ok(snapshot?.descendants.length > 1)
      }
      const pids = [proc.pid, ...snapshot.descendants.map((row) => row.pid)]
      const before = await ownedPidRows(pids)
      assert.ok(before.includes('omp'), `Expected OMP process: ${before}`)
      if (externalTool) {
        assert.ok(before.includes('sleep'))
      }
      const started = Date.now()
      let closeError = null
      try {
        await new TerminalSessionTeardown(new Map([[id, daemonSession]])).killSession(
          id,
          daemonSession,
          true
        )
      } catch (error) {
        closeError = String(error)
      }
      await delay(6000)
      const after = await ownedPidRows(pids)
      report.push({
        launch,
        close,
        externalTool,
        backend: 'daemon',
        before,
        after,
        nativeExit,
        tracked: daemonSession.isAlive,
        elapsedMs: Date.now() - started,
        closeError,
        home
      })
      writeFileSync(join(output, `${id}.txt`), transcript)
      writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
      assert.equal(closeError, null)
      assert.equal(after, '')
    } finally {
      writeFileSync(join(output, `${id}.txt`), transcript)
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
      daemonSession?.dispose()
      exitSubscription.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  return output
}
