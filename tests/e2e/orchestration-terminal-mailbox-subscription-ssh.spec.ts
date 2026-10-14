import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { reconnect, serverCall } from './helpers/orcad-convert-flow'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { createManagedMailboxAgent } from './helpers/managed-mailbox-agent'
import { CODEX_IDLE_TITLE, CODEX_WORKING_TITLE } from './helpers/orchestration-mail-pane-agent'

const TerminalList = z.object({
  result: z.object({
    terminals: z.array(
      z.object({ handle: z.string(), ptyId: z.string().nullable(), title: z.string().nullable() })
    )
  })
})
const Created = z.object({ result: z.object({ agentTerminalHandle: z.string() }) })
const Sent = z.object({ result: z.object({ message: z.object({ id: z.string() }) }) })
const Inbox = z.object({
  result: z.object({
    messages: z.array(
      z.object({ id: z.string(), read: z.number(), delivered_at: z.string().nullable() })
    )
  })
})
const POINTER_COMMAND = 'orchestration inbox'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The managed Docker host fixture uses POSIX tooling')

test('a managed SSH host preserves its subscription and pending mail across a viewer reconnect', async (// oxlint-disable-next-line no-empty-pattern -- Owns its hidden app through the managed-host fixture.
{}, testInfo) => {
  test.setTimeout(12 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    if (!fixture.host.exec) {
      throw new Error('Missing disposable Docker host control')
    }
    const agent = createManagedMailboxAgent(fixture.host.exec)
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const call = (method: string, params?: unknown) =>
      serverCall(page, environmentId, method, params)
    await call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'codex',
      value: agent.launchCommand
    })
    await call('settings.mutateAgentLaunch', {
      type: 'availability',
      agent: 'codex',
      enabled: true
    })
    const created = Created.parse(
      JSON.parse(
        await call('worktree.create', {
          repo: `id:${seeded.repoId}`,
          name: 'ssh-subscription',
          noParent: true,
          activate: false,
          setupDecision: 'skip',
          startupAgent: 'codex',
          startupPrompt: ''
        })
      )
    )
    const handle = created.result.agentTerminalHandle
    const terminal = async () => {
      const listed = TerminalList.parse(JSON.parse(await call('terminal.list')))
      return listed.result.terminals.find((entry) => entry.handle === handle)
    }
    await expect
      .poll(() => agent.readLedger().find((entry) => entry.event === 'start'), { timeout: 60_000 })
      .toMatchObject({ hasLaunchToken: true, terminalHandle: handle })
    await expect.poll(terminal, { timeout: 30_000 }).toMatchObject({ ptyId: expect.any(String) })
    const ptyId = (await terminal())!.ptyId
    const setTitle = async (title: string): Promise<void> => {
      agent.setTitle(title)
      await expect.poll(async () => (await terminal())?.title).toBe(title)
    }
    await setTitle(CODEX_WORKING_TITLE)
    agent.runCli('subscribe', ['orchestration', 'subscribe', '--json'])
    await expect
      .poll(() => agent.readCliResult('subscribe'), { timeout: 30_000 })
      .toMatchObject({ status: 0 })
    expect(JSON.parse(agent.readCliResult('subscribe')?.stdout ?? '')).toMatchObject({
      ok: true,
      result: { subscribed: true }
    })

    const body = 'MANAGED_HOST_BODY_MUST_NOT_ENTER_PTY'
    // The CLI supplies the mutation contract and caller evidence omitted by passive renderer RPC.
    agent.runCli('send', [
      'orchestration',
      'send',
      '--to',
      handle,
      '--subject',
      'queued while the receiver is working',
      '--body',
      body,
      '--type',
      'status',
      '--json'
    ])
    await expect
      .poll(() => agent.readCliResult('send'), { timeout: 30_000 })
      .toMatchObject({ status: 0 })
    const sent = Sent.parse(JSON.parse(agent.readCliResult('send')?.stdout ?? ''))
    // inbox is a non-consuming history read; check would acknowledge the delivery under test.
    const message = async () => {
      const inbox = Inbox.parse(JSON.parse(await call('orchestration.inbox', { terminal: handle })))
      return inbox.result.messages.find((entry) => entry.id === sent.result.message.id)
    }
    await expect.poll(message).toMatchObject({ read: 0, delivered_at: null })
    const before = agent.readStdin()
    await page.evaluate((targetId) => window.api.ssh.disconnect({ targetId }), seeded.targetId)
    await expect
      .poll(() =>
        page.evaluate(
          async (targetId) => (await window.api.ssh.getState({ targetId }))?.status,
          seeded.targetId
        )
      )
      .not.toBe('connected')
    // The execution host still owns the working receiver; losing its viewer never authorizes input.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(agent.readStdin()).toBe(before)
    await reconnect(page, seeded.targetId)
    await expect.poll(terminal, { timeout: 60_000 }).toMatchObject({ ptyId })
    agent.runCli('status-reconnected', ['orchestration', 'subscription', 'status', '--json'])
    await expect
      .poll(() => agent.readCliResult('status-reconnected'), { timeout: 30_000 })
      .toMatchObject({ status: 0 })
    expect(JSON.parse(agent.readCliResult('status-reconnected')?.stdout ?? '')).toMatchObject({
      ok: true,
      result: { subscribed: true }
    })
    expect(agent.readStdin()).toBe(before)
    await expect.poll(message).toMatchObject({ read: 0, delivered_at: null })

    await setTitle(CODEX_IDLE_TITLE)
    await expect
      .poll(() => agent.readStdin().slice(before.length), { timeout: 60_000 })
      .toContain(POINTER_COMMAND)
    await expect.poll(() => agent.readStdin().slice(before.length).split('\r').length - 1).toBe(1)
    await expect.poll(message).toMatchObject({ read: 0, delivered_at: expect.any(String) })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const delivered = agent.readStdin().slice(before.length)
    expect(delivered.split(POINTER_COMMAND).length - 1).toBe(1)
    expect(delivered.split('\r').length - 1).toBe(1)
    expect(delivered).not.toContain(body)
    expect(await terminal()).toMatchObject({ ptyId })
  })
})
