/** Isolated native interop and live restart probe; never point at a user's Rex server. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { RexPtyProvider } from '../../../src/main/providers/rex-pty/rex-pty-provider'
import { RexSessionStore } from '../../../src/main/providers/rex-pty/rex-session-store'
import { RexControl } from '../../../src/main/providers/rex-pty/rex-control'
import { createRexSnapshotDecoder } from '../../../src/main/providers/rex-pty/rex-snapshot-worker'
import { createRexLaunchPayloadFactory } from '../../../src/main/providers/rex-pty/rex-launch-worker'
import {
  rexAttachedSession,
  rexOwnedBlocks,
  rexTerminalProcess,
  rexTerminalSize
} from '../../../src/main/providers/rex-pty/rex-rpc-schema'

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000
  while (!(await predicate())) {
    assert(Date.now() < end, 'fixture deadline')
    await delay(25)
  }
}

async function main() {
  const [socket, wasm, worker, launcher, cli] = process.argv.slice(2)
  assert(socket && wasm && worker && launcher && cli)
  assert(socket.includes('/rx-core.'), 'disposable fixture socket required')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rex-core-live-')))
  const store = new RexSessionStore(join(dir, 'records'))
  const make = () =>
    new RexPtyProvider(
      socket,
      store,
      createRexSnapshotDecoder(wasm, worker),
      createRexLaunchPayloadFactory(launcher, dir)
    )
  const first = make()
  const second = make()
  const id = `folder@@rex-${randomUUID()}`
  const opts = {
    sessionId: id,
    isNewSession: true,
    cols: 80,
    rows: 24,
    cwd: dir,
    worktreeId: 'folder',
    paneKey: 'tab:leaf',
    shellOverride: '/bin/bash',
    terminalShellArgs: ['--noprofile', '--norc', '-i']
  }
  let owner = first
  let ctl: RexControl | undefined
  let output = ''
  const off1 = first.onData((e) => {
    output += e.data
  })
  const off2 = second.onData((e) => {
    output += e.data
  })
  try {
    await assert.rejects(first.spawn({ ...opts, command: 'exit' }), /Unsupported Rex spawn option/)
    await assert.rejects(
      first.spawn({ ...opts, terminalShellArgs: ['-c', 'exit'] }),
      /Unsupported Rex interactive shell arguments/
    )
    await assert.rejects(first.spawn({ ...opts, cwd: join(dir, 'missing') }))
    assert.deepEqual(await store.list(), [])
    console.log('PASS unsupported fresh launch refused before native dispatch')
    const initial = await first.spawn(opts)
    const record = await store.read(id)
    assert.equal(initial.pid, record.rootPid)
    assert.equal(initial.incarnationId, record.incarnationId)
    await assert.rejects(first.spawn(opts), /already exists/)
    await assert.rejects(
      first.spawn({ ...opts, isNewSession: false, expectedIncarnationId: randomUUID() }),
      /incarnation mismatch/
    )
    assert.equal(
      (await first.writeWithSettlement(id, "printf 'CORE_%s\\n' INITIAL\r")).outcome,
      'accepted'
    )
    await until(() => output.includes('CORE_INITIAL'))
    first.resize(id, 83, 25)
    await until(async () => (await first.getAppliedSize(id))?.cols === 83)
    assert.deepEqual(await first.getAppliedSize(id), { cols: 83, rows: 25 })
    console.log('PASS owning client resizes native grid with exact readback')
    const target = { session_id: record.sessionId, block_id: record.blockId }
    const format = z.object({ content: z.string() })
    const cliResult = await promisify(execFile)(
      cli,
      [
        '-S',
        `unix://${socket}`,
        '--autostart=false',
        'api',
        'call',
        'com.superlogical.terminal.format',
        JSON.stringify({ ...target, args: { format: 'text' } })
      ],
      { encoding: 'utf8', timeout: 8000 }
    )
    assert(format.parse(JSON.parse(cliResult.stdout)).content.includes('CORE_INITIAL'))
    console.log('PASS managed native shell and independent official Rex CLI see same terminal')
    ctl = await RexControl.connect(socket)
    const observer = ctl
    const client = await observer.call(
      'session.attach',
      { session_id: record.sessionId },
      rexAttachedSession.parse
    )
    const size = () =>
      observer.call(
        'com.superlogical.terminal.size',
        { ...target, args: {} },
        rexTerminalSize.parse
      )
    const proc = () =>
      observer.call(
        'com.superlogical.terminal.process',
        { ...target, args: {} },
        rexTerminalProcess.parse
      )
    const taken = await observer.call(
      'session.own_block',
      { session_id: record.sessionId, block_ids: [record.blockId], mode: 'take' },
      rexOwnedBlocks.parse
    )
    assert.equal(taken.blocks?.[0]?.owner, client.client_id)
    await observer.call('com.superlogical.terminal.resize', {
      ...target,
      args: { columns: 91, rows: 27 }
    })
    await until(async () => (await size()).columns === 91)
    const active = await first.attach(id)
    assert.equal(active.pid, initial.pid)
    assert.equal(active.incarnationId, initial.incarnationId)
    assert.equal(active.snapshotCols, 91)
    assert(active.snapshot?.includes('CORE_INITIAL'))
    assert.equal((await size()).owner, client.client_id)
    assert.equal((await first.writeWithSettlement(id, 'never send')).outcome, 'refused')
    first.activateRestored(id)
    assert.equal(
      (await first.writeWithSettlement(id, "printf 'CORE_%s\\n' ACTIVE\r")).outcome,
      'accepted'
    )
    await until(() => output.includes('CORE_ACTIVE'))
    console.log('PASS live capture while another client owns size; held input fenced and resumed')
    await first.detach(id)
    owner = second
    const restored = await second.spawn({
      cols: 80,
      rows: 24,
      sessionId: id,
      attachOnly: true,
      expectedIncarnationId: record.incarnationId,
      worktreeId: 'folder',
      paneKey: 'tab:leaf'
    })
    assert.equal(restored.pid, initial.pid)
    assert.equal(restored.incarnationId, initial.incarnationId)
    assert(restored.snapshot?.includes('CORE_ACTIVE'))
    assert.equal((await size()).owner, client.client_id)
    assert.equal((await proc()).child?.pid, initial.pid)
    second.activateRestored(id)
    output = ''
    assert.equal(
      (await second.writeWithSettlement(id, "printf 'CORE_%s\\n' RESTART\r")).outcome,
      'accepted'
    )
    await until(() => output.includes('CORE_RESTART'))
    assert.equal(
      (await second.listProcesses({ ptyIds: [id] }))[0]?.incarnationId,
      record.incarnationId
    )
    await assert.rejects(
      second.shutdown(id, { keepHistory: true }),
      /Unsupported Rex termination request/
    )
    await assert.rejects(
      second.shutdown(id, { expectedOwnerClientInstanceId: 'client:not-authorized' }),
      /Unsupported Rex termination request/
    )
    assert.equal((await proc()).child?.pid, initial.pid)
    console.log(
      'PASS controller restart reattaches exact process with history, no size ownership theft or unsupported close'
    )
    await observer.call('session.detach', { session_id: record.sessionId })
    observer.close()
    ctl = undefined
    await second.shutdown(id, { expectedIncarnationId: record.incarnationId })
    assert.deepEqual(await store.list(), [])
    console.log('PASS managed exact close and record cleanup')
    const exitId = `folder@@rex-${randomUUID()}`
    let exit: { code: number; incarnationId?: string } | undefined
    const offExit = second.onExit((event) => {
      if (event.id === exitId) {
        exit = event
      }
    })
    try {
      const natural = await second.spawn({ ...opts, sessionId: exitId })
      assert.equal((await second.writeWithSettlement(exitId, 'exit 7\r')).outcome, 'accepted')
      await until(() => exit !== undefined)
      assert.equal(exit?.code, 7)
      assert.equal(exit?.incarnationId, natural.incarnationId)
      assert.equal((await second.writeWithSettlement(exitId, 'never send')).outcome, 'refused')
      await until(async () => !second.hasPty(exitId) && (await store.list()).length === 0)
      console.log(
        'PASS natural shell exit reports exact incarnation and reclaims Orca identity without native close'
      )
    } finally {
      offExit()
    }
  } finally {
    ctl?.close()
    off1()
    off2()
    if ((await store.list()).length) {
      await owner.shutdown(id, {}).catch(() => undefined)
    }
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
