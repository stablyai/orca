// Launches the copied Orca.exe as the daemon host (ELECTRON_RUN_AS_NODE=1) and
// waits for its {type:'ready'} IPC signal. Mirrors the real fork() options in
// src/main/daemon/daemon-init.ts (detached, ipc channel, ORCA_USER_DATA_PATH).

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

/**
 * Spawn the daemon host. Resolves { child, pid } once the daemon signals ready,
 * or rejects on early exit / timeout. stdout+stderr are teed to files under
 * workDir. The caller owns shutdown (SIGTERM `child`).
 */
export function launchDaemonHost(options) {
  const {
    hostExePath,
    daemonEntryPath,
    socketPath,
    tokenPath,
    workDir,
    nodePtyNativeDir,
    logFilePath,
    readyTimeoutMs = 30000
  } = options

  const stdoutLog = createWriteStream(join(workDir, 'daemon-stdout.log'))
  const stderrLog = createWriteStream(join(workDir, 'daemon-stderr.log'))

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ORCA_USER_DATA_PATH: workDir
  }
  // The current branch's node-pty patch resolves natives relative to its own
  // dir, so this env var is inert there; set it anyway so the spike still works
  // if run against a build that carries the ORCA_NODE_PTY_NATIVE_DIR patch.
  if (nodePtyNativeDir) {
    env.ORCA_NODE_PTY_NATIVE_DIR = nodePtyNativeDir
  }

  // Why: --log-file makes the daemon write its session lifecycle events
  // (session-created / session-exited / uncaught-exception-suppressed) to a
  // file, which is the only window into ConPTY spawn failures that don't reach
  // stdout/stderr. daemon-entry parses it as an optional Phase 0 flag.
  const daemonArgs = [daemonEntryPath, '--socket', socketPath, '--token', tokenPath]
  if (logFilePath) {
    daemonArgs.push('--log-file', logFilePath)
  }

  const child = spawn(hostExePath, daemonArgs, {
    cwd: workDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env
  })
  child.stdout.pipe(stdoutLog)
  child.stderr.pipe(stderrLog)

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`daemon did not signal ready within ${readyTimeoutMs}ms`))
    }, readyTimeoutMs)

    function finish(err) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
      if (err) {
        // Expose the still-running detached child so the caller can stop it;
        // otherwise a ready-timeout leaks the daemon with no handle to kill it.
        err.child = child
        reject(err)
      } else {
        resolve({ child, pid: child.pid })
      }
    }
    function onMessage(msg) {
      if (msg && typeof msg === 'object' && msg.type === 'ready') {
        finish(null)
      }
    }
    function onError(err) {
      finish(err)
    }
    function onExit(code, signal) {
      finish(new Error(`daemon exited before ready (code=${code}, signal=${signal})`))
    }

    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}
