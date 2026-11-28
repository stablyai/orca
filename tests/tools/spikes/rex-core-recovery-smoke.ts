/** Disposable native server: crash real controllers around durable launch boundaries. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { RexPtyProvider } from '../../../src/main/providers/rex-pty/rex-pty-provider'
import { RexSessionStore } from '../../../src/main/providers/rex-pty/rex-session-store'
import { RexControl } from '../../../src/main/providers/rex-pty/rex-control'
import { createRexSnapshotDecoder } from '../../../src/main/providers/rex-pty/rex-snapshot-worker'
import { createRexLaunchPayloadFactory } from '../../../src/main/providers/rex-pty/rex-launch-worker'
import { recoverRexFreshIntents } from '../../../src/main/providers/rex-pty/rex-fresh-recovery'

class CrashAfterReleaseStore extends RexSessionStore {
  override async reserveFresh(id: string) {
    const reservation = await super.reserveFresh(id)
    return {
      ...reservation,
      markReleased: async (incarnation: string) => {
        await reservation.markReleased(incarnation)
        process.exit(77)
      }
    }
  }
}

class CrashBeforeRecordRemovalStore extends RexSessionStore {
  override async remove(_id: string, _incarnation: string): Promise<void> {
    process.exit(77)
  }
}

const [socket, wasm, worker, launcher, role, phase, id, path] = process.argv.slice(2)
assert(socket && wasm && worker && launcher && socket.includes('/rx-core.'))
const make = (store: RexSessionStore, dir: string) =>
  new RexPtyProvider(
    socket,
    store,
    createRexSnapshotDecoder(wasm, worker),
    createRexLaunchPayloadFactory(launcher, dir)
  )
const options = (id: string, dir: string) => ({
  sessionId: id,
  isNewSession: true,
  cols: 80,
  rows: 24,
  cwd: dir,
  worktreeId: 'folder',
  paneKey: 'tab:leaf',
  shellOverride: '/bin/bash',
  terminalShellArgs: ['--noprofile', '--norc', '-i']
})

async function child() {
  assert(phase && id && path)
  const records = join(path, 'records')
  const store =
    phase === 'released'
      ? new CrashAfterReleaseStore(records)
      : phase === 'retire-close' || phase === 'retire-natural'
        ? new CrashBeforeRecordRemovalStore(records)
        : new RexSessionStore(records)
  if (phase === 'before') {
    await store.reserveFresh(id)
    process.exit(77)
  }
  const provider = make(store, path)
  if (phase === 'retire-close' || phase === 'retire-unconfirmed') {
    const record = await store.read(id)
    if (phase === 'retire-unconfirmed') {
      await store.retirements.reserve(record, [])
      process.exit(77)
    }
    await provider.shutdown(id, { expectedIncarnationId: record.incarnationId })
    throw new Error('Expected interrupted explicit retirement')
  }
  if (phase === 'retire-natural') {
    await provider.spawn(options(id, path))
    assert.equal((await provider.writeWithSettlement(id, 'exit 7\r')).outcome, 'accepted')
    await delay(10000)
    throw new Error('Expected interrupted natural retirement')
  }
  await provider.spawn({
    ...options(id, path),
    ...(phase === 'created' ? { onPtySpawnCommitted: () => process.exit(77) } : {})
  })
  throw new Error('Expected intentional controller crash')
}

async function crash(phase: string, id: string, dir: string) {
  const child = spawn(
    process.execPath,
    [process.argv[1], socket, wasm, worker, launcher, 'child', phase, id, dir],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  const [code] = await once(child, 'exit')
  assert.equal(code, 77)
}

async function countSessions(): Promise<number> {
  const ctl = await RexControl.connect(socket)
  try {
    const list = await ctl.call(
      'session.list',
      {},
      z.object({ sessions: z.array(z.unknown()).nullable() }).parse
    )
    return list.sessions?.length ?? 0
  } finally {
    ctl.close()
  }
}

async function verifyRetirementRecovery(
  provider: RexPtyProvider,
  store: RexSessionStore,
  dir: string
) {
  const natural = 'folder@@rex-'.concat(randomUUID())
  await crash('retire-natural', natural, dir)
  const naturalRecord = await store.read(natural)
  assert.equal((await store.retirements.read(naturalRecord))?.kind, 'natural-exit')
  assert.deepEqual(await provider.listProcesses({ ptyIds: [natural] }), [])
  assert.deepEqual(await store.list({ ptyIds: [natural] }), [])
  console.log('PASS actual crash during natural-exit reclamation resolves without native close')

  const closed = 'folder@@rex-'.concat(randomUUID())
  await provider.spawn(options(closed, dir))
  const closedRecord = await store.read(closed)
  await provider.detach(closed)
  await crash('retire-close', closed, dir)
  assert(await store.retirements.read(closedRecord))
  assert.deepEqual(await provider.listProcesses({ ptyIds: [closed] }), [])
  assert.deepEqual(await store.list({ ptyIds: [closed] }), [])
  console.log(
    'PASS actual crash after native close reconciles exact retirement without second close'
  )

  const unknown = 'folder@@rex-'.concat(randomUUID())
  await provider.spawn(options(unknown, dir))
  const unknownRecord = await store.read(unknown)
  await provider.detach(unknown)
  await crash('retire-unconfirmed', unknown, dir)
  await assert.rejects(provider.listProcesses({ ptyIds: [unknown] }), /termination outcome unknown/)
  await assert.rejects(
    provider.shutdown(unknown, { expectedIncarnationId: unknownRecord.incarnationId }),
    /termination outcome unknown/
  )
  const ctl = await RexControl.connect(socket)
  try {
    await ctl.call('session.attach', { session_id: unknownRecord.sessionId })
    const proc = await ctl.call(
      'com.superlogical.terminal.process',
      {
        session_id: unknownRecord.sessionId,
        block_id: unknownRecord.blockId,
        args: {}
      },
      z.object({ child: z.object({ pid: z.number() }) }).parse
    )
    assert.equal(proc.child.pid, unknownRecord.rootPid)
  } finally {
    ctl.close()
  }
  console.log(
    'PASS unconfirmed retirement of a live block refuses inventory/close and preserves the process'
  )
}

async function parent() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rex-recovery-')))
  const store = new RexSessionStore(join(dir, 'records'))
  const provider = make(store, dir)
  const mint = () => 'folder@@rex-'.concat(randomUUID())
  const before = mint()
  const created = mint()
  const released = mint()
  try {
    await crash('before', before, dir)
    assert.equal(await countSessions(), 0)
    await recoverRexFreshIntents(socket, store, [before])
    assert.deepEqual(await store.pendingFreshIds(), [])
    const fresh = await provider.spawn(options(before, dir))
    await provider.shutdown(before, { expectedIncarnationId: fresh.incarnationId })
    console.log(
      'PASS actual controller crash before dispatch clears exact reservation and permits fresh launch'
    )
    await crash('released', released, dir)
    const count = await countSessions()
    await assert.rejects(store.read(released), /launch outcome unknown/)
    await recoverRexFreshIntents(socket, store, [released])
    const record = await store.read(released)
    console.log('root identity resolution', record.rootIdentity?.resolution)
    const restored = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: released,
      attachOnly: true,
      expectedIncarnationId: record.incarnationId,
      worktreeId: 'folder',
      paneKey: 'tab:leaf'
    })
    assert.equal(restored.pid, record.rootPid)
    assert.equal(restored.incarnationId, record.incarnationId)
    assert.equal(await countSessions(), count)
    provider.activateRestored(released)
    let output = ''
    const off = provider.onData((event) => {
      if (event.id === released) {
        output += event.data
      }
    })
    try {
      assert.equal(
        (await provider.writeWithSettlement(released, "printf 'RECOVERY_%s\\n' LIVE\r")).outcome,
        'accepted'
      )
      const deadline = Date.now() + 5000
      while (!output.includes('RECOVERY_LIVE')) {
        assert(Date.now() < deadline)
        await delay(25)
      }
    } finally {
      off()
    }
    await provider.shutdown(released, { expectedIncarnationId: record.incarnationId })
    console.log(
      'PASS actual crash after durable gate release: same PID/incarnation reattached, input works, no native create replay'
    )
    await verifyRetirementRecovery(provider, store, dir)
    await crash('created', created, dir)
    const unknownCount = await countSessions()
    await recoverRexFreshIntents(socket, store, [created])
    assert.deepEqual(await store.pendingFreshIds(), [created])
    await assert.rejects(
      provider.spawn(options(created, dir)),
      /launch outcome unknown: native create may have executed.*orca-rex-/
    )
    await assert.rejects(provider.listProcesses({ ptyIds: [created] }), /launch outcome unknown/)
    assert.equal(await countSessions(), unknownCount)
    console.log(
      'PASS actual crash after native create before identity publication remains fenced; no second create'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
void (role === 'child' ? child() : parent()).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
