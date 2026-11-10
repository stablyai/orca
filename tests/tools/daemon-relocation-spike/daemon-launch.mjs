// Launch copied Orca.exe as run-as-node daemon with production detached/IPC/userData options, awaiting ready.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

// Return child/pid on ready, reject exit/timeout, and tee logs under workDir; caller owns child shutdown.
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
  // Set ORCA_NODE_PTY_NATIVE_DIR for older patched builds; current native resolution is relative to node-pty itself.
  if (nodePtyNativeDir) {
    env.ORCA_NODE_PTY_NATIVE_DIR = nodePtyNativeDir
  }

  // Capture --log-file session/crash events because some ConPTY spawn failures never reach stdio.
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
        // Attach the child to timeout errors so callers can kill a detached daemon that never reached ready.
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
