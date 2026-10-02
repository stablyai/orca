const assert = require('node:assert/strict')
const { test } = require('node:test')
const { parseRasterRunOptions } = require('./raster-run-input.cjs')
const { parseRasterReadyJson, verifyRasterRuntimeTarget } = require('./raster-runtime-target.cjs')

const validArgs = [
  '--user-data',
  'private-user-data',
  '--ready',
  'private-ready.json',
  '--output',
  'private-results',
  '--project-root',
  'private-project'
]

test('accepts the four named runtime paths without rewriting them', () => {
  assert.deepEqual(parseRasterRunOptions(validArgs), {
    userData: 'private-user-data',
    readyFile: 'private-ready.json',
    output: 'private-results',
    projectRoot: 'private-project'
  })
})

test('rejects every missing required flag rather than reusing argv[0]', () => {
  for (let index = 0; index < validArgs.length; index += 2) {
    assert.throws(() => parseRasterRunOptions(validArgs.toSpliced(index, 2)))
  }
})

test('rejects duplicate flags rather than silently choosing one target', () => {
  for (let index = 0; index < validArgs.length; index += 2) {
    assert.throws(() => parseRasterRunOptions([...validArgs, validArgs[index], 'other-path']))
  }
})

test('rejects unknown options and positional arguments', () => {
  assert.throws(() => parseRasterRunOptions([...validArgs, '--typo', 'path']))
  assert.throws(() => parseRasterRunOptions([...validArgs, 'unexpected']))
})

test('rejects missing and empty option values', () => {
  assert.throws(() => parseRasterRunOptions(validArgs.slice(0, -1)))
  assert.throws(() => parseRasterRunOptions([...validArgs.slice(0, -1), '']))
  assert.throws(() => parseRasterRunOptions([...validArgs.slice(0, -1), '   ']))
  assert.throws(() => parseRasterRunOptions(validArgs.toSpliced(1, 1)))
  assert.throws(() => parseRasterRunOptions([...validArgs.slice(0, -1), 'path\0suffix']))
})

test('accepts named equals-form values while rejecting duplicate equals-form flags', () => {
  const equalsArgs = []
  for (let index = 0; index < validArgs.length; index += 2) {
    equalsArgs.push(`${validArgs[index]}=${validArgs[index + 1]}`)
  }
  assert.deepEqual(parseRasterRunOptions(equalsArgs), parseRasterRunOptions(validArgs))
  assert.throws(() => parseRasterRunOptions([...equalsArgs, '--ready=other-ready.json']))
})

const ready = { runtimeId: 'isolated-runtime', pairing: { url: 'test-pairing' } }

function runtimeProbe({
  local = { ok: true, result: { runtime: { runtimeId: ready.runtimeId } } },
  remote = { ok: true, result: { runtimeId: ready.runtimeId } },
  readyDocument = ready
} = {}) {
  const calls = []
  const pairing = { fixture: 'decoded-pairing' }
  const dependencies = {
    ready: readyDocument,
    userData: 'private-user-data',
    decodePairingOffer(url) {
      calls.push(['decode', url])
      return pairing
    },
    async getCliStatus(userData) {
      calls.push(['local-status', userData])
      return local
    },
    async sendRemoteRuntimeRequest(...args) {
      calls.push(['remote-status', ...args])
      return remote
    },
    RuntimeClient: class {
      constructor(...args) {
        calls.push(['client', ...args])
        // Mirror the real constructor's inherited-selection hazard without touching process.env.
        const [, , remotePairing = 'inherited-pairing', environment = 'inherited-environment'] =
          args
        this.remotePairing = remotePairing
        this.environment = environment
      }
    }
  }
  return { dependencies, calls, pairing }
}

test('validates both read-only identities before creating an explicitly local client', async () => {
  const probe = runtimeProbe()
  const target = await verifyRasterRuntimeTarget(probe.dependencies)
  assert.equal(target.pairing, probe.pairing)
  assert.equal(target.client.remotePairing, null)
  assert.equal(target.client.environment, null)
  assert.deepEqual(probe.calls, [
    ['decode', ready.pairing.url],
    ['local-status', 'private-user-data'],
    ['remote-status', probe.pairing, 'status.get', {}, 10000],
    ['client', 'private-user-data', 10000, null, null]
  ])
})

test('refuses local mismatches or unavailable identity before contacting the pairing target', async () => {
  for (const local of [
    { ok: true, result: { runtime: { runtimeId: 'another-runtime' } } },
    { ok: true, result: { runtime: { runtimeId: null } } },
    { ok: false, result: { runtime: { runtimeId: ready.runtimeId } } },
    { ok: true, result: {} }
  ]) {
    const probe = runtimeProbe({ local })
    await assert.rejects(verifyRasterRuntimeTarget(probe.dependencies), /Local runtime identity/)
    assert.equal(
      probe.calls.some(([operation]) => operation === 'remote-status'),
      false
    )
    assert.equal(
      probe.calls.some(([operation]) => operation === 'client'),
      false
    )
  }
})

test('refuses mismatched or missing paired identity before creating a mutation client', async () => {
  for (const remote of [
    { ok: true, result: { runtimeId: 'another-runtime' } },
    { ok: true, result: {} },
    { ok: false, result: { runtimeId: ready.runtimeId } }
  ]) {
    const probe = runtimeProbe({ remote })
    await assert.rejects(verifyRasterRuntimeTarget(probe.dependencies), /Paired runtime identity/)
    assert.equal(
      probe.calls.some(([operation]) => operation === 'client'),
      false
    )
  }
})

test('rejects invalid readiness fields without probing either runtime', async () => {
  for (const readyDocument of [
    null,
    {},
    { ...ready, runtimeId: '' },
    { ...ready, runtimeId: 1 },
    { ...ready, runtimeId: '   ' },
    { runtimeId: ready.runtimeId },
    { ...ready, pairing: { url: '' } }
  ]) {
    const probe = runtimeProbe({ readyDocument })
    await assert.rejects(verifyRasterRuntimeTarget(probe.dependencies), /Invalid readiness/)
    assert.deepEqual(probe.calls, [])
  }
})

test('does not put malformed readiness JSON or its credentials in an error', () => {
  const secret = 'private-pairing-credential'
  assert.throws(
    () => parseRasterReadyJson(`${secret}: invalid JSON`),
    (error) => {
      assert.equal(error.message, 'Invalid readiness JSON')
      assert.equal(String(error).includes(secret), false)
      return true
    }
  )
  assert.deepEqual(parseRasterReadyJson(JSON.stringify(ready)), ready)
})

test('propagates read-only probe failures without constructing a mutation client', async () => {
  for (const operation of ['getCliStatus', 'sendRemoteRuntimeRequest']) {
    const probe = runtimeProbe()
    probe.dependencies[operation] = async () => {
      throw new Error('status probe failed')
    }
    await assert.rejects(verifyRasterRuntimeTarget(probe.dependencies), /status probe failed/)
    assert.equal(
      probe.calls.some(([name]) => name === 'client'),
      false
    )
  }
})

test('sanitizes pairing decoder errors without probing or constructing a client', async () => {
  const probe = runtimeProbe()
  probe.dependencies.decodePairingOffer = () => {
    throw new Error('private-pairing-credential')
  }
  await assert.rejects(verifyRasterRuntimeTarget(probe.dependencies), {
    message: 'Invalid readiness pairing'
  })
  assert.deepEqual(probe.calls, [])
})
