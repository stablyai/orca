/** Disposable server only: cumulative natural exits and pressure reclamation. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { RexPtyProvider } from '../../../src/main/providers/rex-pty/rex-pty-provider'
import {
  MAX_REX_RECORDS,
  RexSessionStore
} from '../../../src/main/providers/rex-pty/rex-session-store'
import { RexControl } from '../../../src/main/providers/rex-pty/rex-control'
import { createRexSnapshotDecoder } from '../../../src/main/providers/rex-pty/rex-snapshot-worker'
import { createRexLaunchPayloadFactory } from '../../../src/main/providers/rex-pty/rex-launch-worker'
import { providerOwnerPidAbsent } from '../../../src/main/provider-process/provider-process-row-read'
import type { RexSessionRecord } from '../../../src/main/providers/rex-pty/rex-session-record'

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000
  while (!(await predicate())) {
    assert(Date.now() < deadline, 'reclamation deadline')
    await delay(25)
  }
}

async function assertNativeHistory(socket: string, record: RexSessionRecord) {
  const control = await RexControl.connect(socket)
  try {
    await control.call('session.attach', { session_id: record.sessionId })
    const text = await control.call(
      'com.superlogical.terminal.format',
      { session_id: record.sessionId, block_id: record.blockId, args: { format: 'text' } },
      z.object({ content: z.string() }).parse
    )
    assert(text.content.includes('RECLAIM_MARKER'))
  } finally {
    control.close()
  }
}

async function main() {
  const [socket, wasm, worker, launcher, mode] = process.argv.slice(2)
  assert(socket && wasm && worker && launcher && socket.includes('/rx-core.'))
  assert(mode === 'attached' || mode === 'detached' || mode === 'native-limit')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rex-reclamation-')))
  const store = new RexSessionStore(join(dir, 'records'))
  const make = () =>
    new RexPtyProvider(
      socket,
      store,
      createRexSnapshotDecoder(wasm, worker),
      createRexLaunchPayloadFactory(launcher, dir)
    )
  const provider = make()
  const records: RexSessionRecord[] = []
  const spawn = async (owner: RexPtyProvider) => {
    const id = 'folder@@rex-'.concat(randomUUID())
    await owner.spawn({
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
    return store.read(id)
  }
  try {
    const count =
      mode === 'native-limit' ? 64 : mode === 'attached' ? MAX_REX_RECORDS + 2 : MAX_REX_RECORDS
    for (let i = 0; i < count; i++) {
      const record = await spawn(provider)
      records.push(record)
      const command =
        mode !== 'detached'
          ? "printf 'RECLAIM_%s\\n' MARKER; exit 7\r"
          : "printf 'RECLAIM_%s\\n' MARKER; sleep 1; exit 7\r"
      assert.equal((await provider.writeWithSettlement(record.id, command)).outcome, 'accepted')
      await (mode === 'detached'
        ? provider.detach(record.id)
        : until(async () => !provider.hasPty(record.id) && (await store.list()).length === 0))
      if ((i + 1) % 32 === 0) {
        console.log('completed', i + 1, mode)
      }
    }
    if (mode === 'native-limit') {
      assert.deepEqual(await store.list(), [])
      await assert.rejects(spawn(provider), /Rex server session limit reached/)
      assert.deepEqual(await store.list(), [])
      const control = await RexControl.connect(socket)
      try {
        // Explicit operator action on this disposable fixture only. Product code never destroys sessions.
        await control.call('session.attach', { session_id: records[0].sessionId })
        await control.call('session.destroy', { session_id: records[0].sessionId })
      } finally {
        control.close()
      }
      const fresh = await spawn(provider)
      await provider.shutdown(fresh.id, { expectedIncarnationId: fresh.incarnationId })
      assert.deepEqual(await store.list(), [])
      await assertNativeHistory(socket, records[1])
      console.log(
        'PASS default native limit: definitive rejection does not poison inventory; explicit operator pruning allows a new shell'
      )
    } else if (mode === 'attached') {
      assert.deepEqual(await store.list(), [])
      await assertNativeHistory(socket, records[0])
      console.log('PASS 130 natural exits reclaimed; first native history remains')
    } else {
      await until(() => records.every((record) => providerOwnerPidAbsent(record.rootPid)))
      assert.equal((await store.list()).length, MAX_REX_RECORDS)
      const next = make()
      const fresh = await spawn(next)
      assert.equal((await store.list()).length, MAX_REX_RECORDS)
      await next.shutdown(fresh.id, { expectedIncarnationId: fresh.incarnationId })
      assert.equal((await store.list()).length, MAX_REX_RECORDS - 1)
      await assertNativeHistory(socket, records[0])
      console.log(
        'PASS 128 detached exits; restart reclaims one exact identity under capacity pressure without deleting native history'
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
