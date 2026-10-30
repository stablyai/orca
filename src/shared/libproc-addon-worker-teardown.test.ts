import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

// A worker_thread calling into the libproc reads from a timer while it is terminated used to abort the whole
// process (uncaught Napi::Error from a call-in or completion during env teardown), so run it in a child.
const SCRIPT = String.raw`
const { Worker } = require('node:worker_threads')
const ptyDir = process.argv[1]
function once(run) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      'const m = require(' + JSON.stringify(ptyDir + '/lib/utils') + ').loadNativeModule("pty").module;' +
        'setInterval(() => { m.readProcessTable({ command: false }); m.readProcessCwd(process.pid); m.readProcessPath(process.pid) }, 0);' +
        'require("node:worker_threads").parentPort.postMessage(0)',
      { eval: true }
    )
    worker.on('message', () => setTimeout(() => worker.terminate().then(resolve, reject), run % 7))
    worker.on('error', reject)
  })
}
;(async () => {
  for (let run = 0; run < 100; run += 1) await once(run)
  console.log('survived')
})()
`

describe.runIf(process.platform === 'darwin')('libproc addon worker teardown', () => {
  // 100 worker_thread starts and terminates in a child node take a few seconds, more under suite load.
  it(
    'survives terminating a worker thread that keeps calling the native reads',
    { timeout: 60_000 },
    () => {
      const ptyDir = dirname(createRequire(__filename).resolve('node-pty/package.json'))
      const child = spawnSync(process.execPath, ['-e', SCRIPT, ptyDir], {
        encoding: 'utf8',
        timeout: 50_000
      })
      expect(child.stderr).not.toContain('terminating due to uncaught exception')
      expect(child.stdout.trim()).toBe('survived')
      expect(child.status).toBe(0)
    }
  )
})
