/**
 * A paired client cannot set up a project on an SSH host its headless server owns: the server
 * reaches that host's runtime over its own tunnel, which the client has no route to. Adding or
 * cloning there says so plainly instead of failing with a TypeError or "not connected" (#33124).
 */
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient } from './helpers/paired-electron-client'
import { toSshExecutionHostId } from '../../src/shared/execution-host'

const REFUSAL = "This Orca server can't add projects on its SSH hosts."

test('a paired client refuses project setup on its server’s SSH host with a clear reason', async () => {
  // Boots a headless server and a paired Electron client before the refusal is observable.
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const sshTarget = await host.client.call<{ target: { id: string } }>('ssh.addTarget', {
      target: { label: 'Recipe VM', host: '127.0.0.1', port: 1, username: 'dev' }
    })
    const client = await launchPairedWebClient(host.app, host.offer, { waitForWorkspace: false })
    try {
      await expect
        .poll(() => client.page.evaluate(() => Boolean(window.__store)), { timeout: 30_000 })
        .toBe(true)
      const errors = await client.page.evaluate(async (hostId) => {
        const messages: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => {
          messages.push(args.map(String).join(' '))
          original(...args)
        }
        try {
          const state = window.__store!.getState()
          const added = await state.setupProjectExistingFolder({
            projectId: 'project-on-b',
            hostId,
            path: '/home/dev/repo',
            kind: 'git'
          })
          const cloned = await state.setupProjectClone({
            projectId: 'project-on-b',
            hostId,
            url: 'https://example.com/repo.git',
            destination: '/home/dev'
          })
          return { added, cloned, messages }
        } finally {
          console.error = original
        }
      }, toSshExecutionHostId(sshTarget.result.target.id))

      expect(errors.added).toBeNull()
      expect(errors.cloned).toBeNull()
      expect(errors.messages).toHaveLength(2)
      for (const message of errors.messages) {
        expect(message).toContain(REFUSAL)
      }
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
  }
})
