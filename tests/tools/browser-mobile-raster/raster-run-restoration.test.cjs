const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

// Execute the real runner; replace only its runtime, clock waits and filesystem I/O.
async function runFixture({ failSample = false, failRestoration = false } = {}) {
  let result
  let samples = 0
  let active = false
  let viewport = { width: 1280, height: 800, dpr: 2 }
  let clicks = 0
  let frameSequence = 0
  const ready = { runtimeId: 'fixture-runtime', pairing: { url: 'fixture-pairing' } }
  const fileSystem = {
    mkdirSync() {},
    existsSync: () => false,
    readFileSync: (file) =>
      file.endsWith('ready.json') ? JSON.stringify(ready) : Buffer.from('fixture'),
    writeFileSync(file, data) {
      if (file.endsWith('results.json')) {
        result = JSON.parse(data)
      }
    }
  }
  class RuntimeClient {
    async call(method) {
      if (method === 'browser.eval') {
        if (failRestoration && samples === 1 && !active) {
          throw new Error('restoration failed')
        }
        return {
          ok: true,
          result: {
            result: JSON.stringify({
              ...viewport,
              clicks,
              trusted: true,
              button: { x: 80, y: 329 }
            })
          }
        }
      }
      if (method === 'browser.mouseClick') {
        if (failSample && samples === 1) {
          throw new Error('sample body failed')
        }
        clicks += 1
      }
      const results = {
        'repo.add': { id: 'fixture-repo' },
        'browser.profileCreate': { profile: { id: 'fixture-profile' } },
        'browser.tabCreate': { browserPageId: 'fixture-page' }
      }
      return { ok: true, result: results[method] ?? {} }
    }
  }
  const remote = {
    sendRemoteRuntimeRequest: async () => ({ ok: true, result: { runtimeId: ready.runtimeId } }),
    async subscribeRemoteRuntimeRequest(_pairing, _method, options, _timeout, callbacks) {
      samples += 1
      active = true
      viewport = {
        width: options.viewportWidth,
        height: options.viewportHeight,
        dpr: options.deviceScaleFactor
      }
      const scale = Math.min(
        2,
        options.maxWidth / viewport.width,
        options.maxHeight / viewport.height
      )
      const width = Math.round(viewport.width * scale)
      const height = Math.round(viewport.height * scale)
      callbacks.onResponse({
        ok: true,
        result: { type: 'ready', subscriptionId: `fixture:${samples}` }
      })
      for (let i = 0; i < 6; i += 1) {
        callbacks.onBinary(
          Buffer.from([
            255,
            216,
            255,
            192,
            0,
            17,
            8,
            height >> 8,
            height & 255,
            width >> 8,
            width & 255,
            3,
            1,
            17,
            0,
            2,
            17,
            0,
            3,
            17,
            0,
            255,
            217,
            i
          ])
        )
      }
      return {
        sendRequest: async () => ({ ok: true }),
        close() {
          active = false
          viewport = { width: 1280, height: 800, dpr: 2 }
        }
      }
    }
  }
  function loadModule(name) {
    if (name === 'node:fs') {
      return fileSystem
    }
    if (name.startsWith('node:')) {
      return require(name)
    }
    if (name.startsWith('./')) {
      return require(name)
    }
    if (name.endsWith(path.join('cli', 'runtime-client.js'))) {
      return { RuntimeClient }
    }
    if (name.endsWith(path.join('runtime', 'status.js'))) {
      return {
        getCliStatus: async () => ({
          ok: true,
          result: { runtime: { runtimeId: ready.runtimeId } }
        })
      }
    }
    if (name.endsWith('remote-runtime-client.js')) {
      return remote
    }
    if (name.endsWith('pairing.js')) {
      return { decodePairingOffer: () => ({}) }
    }
    if (name.endsWith('browser-screencast-protocol.js')) {
      return {
        decodeBrowserScreencastFrame: (image) => ({
          image,
          seq: frameSequence++,
          metadata: { deviceWidth: viewport.width, deviceHeight: viewport.height }
        })
      }
    }
    throw new Error(`Unexpected runner dependency: ${name}`)
  }
  const root = path.join(path.parse(__dirname).root, 'raster-fixture')
  const processState = {
    argv: [
      'node',
      'run.cjs',
      '--user-data',
      path.join(root, 'data'),
      '--ready',
      path.join(root, 'ready.json'),
      '--output',
      path.join(root, 'output'),
      '--project-root',
      path.join(root, 'project')
    ],
    exitCode: undefined
  }
  await vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8'),
    {
      require: loadModule,
      __dirname,
      Buffer,
      Uint8Array,
      Date,
      process: processState,
      console: { log() {} },
      setTimeout: (callback) => {
        queueMicrotask(callback)
        return 0
      }
    },
    { filename: 'run.cjs' }
  )
  return { result, exitCode: processState.exitCode, samples }
}

test('runner fixture exercises all five successful scenarios without external I/O', async () => {
  const { result, exitCode, samples } = await runFixture()
  assert.equal(exitCode, 0)
  assert.equal(samples, 5)
  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(result.failures, [])
})

test('restoration-only failure is recorded and does not skip later scenarios', async () => {
  const { result, exitCode, samples } = await runFixture({ failRestoration: true })
  assert.equal(exitCode, 1)
  assert.equal(samples, 5)
  assert.equal(result.observations.length, 5)
  assert.deepEqual(result.failures, [
    'portrait-click: restore original surface: restoration failed'
  ])
})

test('restoration failure does not replace the primary sample error', async () => {
  const { result, exitCode } = await runFixture({ failSample: true, failRestoration: true })
  assert.equal(exitCode, 1)
  assert.ok(result.failures.includes('sample body failed'))
  assert.ok(
    result.failures.includes('portrait-click: restore original surface: restoration failed')
  )
})
