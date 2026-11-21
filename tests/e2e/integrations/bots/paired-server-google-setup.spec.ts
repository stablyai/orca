// Google setup for a managed agent on a headless paired server, its tab on the paired desktop: the
// tab opens despite --split, and the key the desktop downloads (by the reference's typed action) is
// imported on the server without ever landing in the agent's workspace.
import { existsSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { launchHeadlessPairedRuntimeHost } from '../../remote/paired-runtime/client-hosts/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from '../../remote/paired-runtime/client-hosts/paired-electron-client'
import { pairedOwnerApp } from './paired-owner-app'

const PROJECT = 'example-project-123'
const SECRET = 'GOCSPX-e2e-secret'
const CLIENTS_URL = `https://console.cloud.google.com/auth/clients?project=${PROJECT}`

// The key file Google Cloud's Download JSON gives a Desktop app client.
const KEY = JSON.stringify({
  installed: {
    client_id: '1-e2e.apps.googleusercontent.com',
    client_secret: SECRET,
    project_id: PROJECT
  }
})

async function startKeyServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/key') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="client_secret_1-e2e.json"'
      })
      response.end(KEY)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>start</title><h1>start</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('key server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

/** Google Cloud's pages, answered inside the desktop's guest session: Create shows the secret. */
async function fakeGoogleCloud(app: ElectronApplication, startUrl: string, keyUrl: string) {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ webContents }, url) => webContents.getAllWebContents().some((c) => c.getURL() === url),
          startUrl
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  await app.evaluate(
    ({ webContents }, { startUrl, html }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getURL() === startUrl)
      guest!.session.protocol.handle(
        'https',
        () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      )
    },
    {
      startUrl,
      html: `<!doctype html><title>Clients</title>
<button id="create" onclick="document.getElementById('dialog').hidden=false">Create</button>
<div id="dialog" hidden><p>OAuth client created</p><p>Client secret ${SECRET}</p>
<a id="download" href="${keyUrl}">Download JSON</a></div>`
    }
  )
}

// oxlint-disable-next-line no-empty-pattern -- Owns the host and client launches; Playwright needs the fixtures argument.
test('a server agent sets Google up through the paired desktop browser', async ({}, testInfo) => {
  // A headless serve host, a paired desktop, and several real page loads and a download.
  test.setTimeout(360_000)
  const { server, origin } = await startKeyServer()
  let launched: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  let client: PairedElectronClient | null = null
  try {
    const host = await launchHeadlessPairedRuntimeHost({ withoutBrowser: true })
    launched = host
    const owner = pairedOwnerApp(host.userDataDir, host.offer.pairingUrl)
    // Never launch a real agent: the stub exits at once.
    await owner.call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'claude',
      value: '/usr/bin/false'
    })
    const {
      result: { bot }
    } = await owner.call<{ bot: { id: string; folder: string; folderWorkspaceId: string } }>(
      'bots.create',
      { name: 'Google Setup Agent', agent: 'claude', takingOver: true }
    )
    client = await launchPairedElectronClient(host.offer, testInfo, 'Google setup agent')

    // The setup reference's `tab create --split right`: a host with no window opens it plain.
    const startUrl = `${origin}/start`
    const {
      result: { browserPageId }
    } = await host.client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      { worktree: `id:folder:${bot.folderWorkspaceId}`, url: startUrl, split: 'right' },
      { timeoutMs: 60_000 }
    )
    await fakeGoogleCloud(client.app, startUrl, `${origin}/key`)

    const setUp = (change: Record<string, unknown>) =>
      owner.call('bots.googleSetup.write', { botId: bot.id, change })
    await setUp({ action: 'start', mode: 'do-it-for-me', browserPageId })
    await setUp({ action: 'set', projectId: PROJECT })

    const agent = async (method: string, params: Record<string, unknown>) =>
      JSON.stringify(
        (await host.client.call(method, { page: browserPageId, ...params }, { timeoutMs: 60_000 }))
          .result
      )

    await setUp({ action: 'step', step: 'client', status: 'active' })
    await agent('browser.goto', { url: CLIENTS_URL })
    await agent('browser.click', { element: '#create' })

    // The reference's Download JSON action, exactly: the desktop says what started the download,
    // and the server imports the key from memory, never from the agent's workspace.
    await agent('browser.find', { locator: 'text', value: 'Download JSON', action: 'click' })
    await expect
      .poll(
        async () =>
          (
            await owner.call<{ run: { steps: { client?: { status: string } } } }>(
              'bots.googleSetup.read',
              { botId: bot.id }
            )
          ).result.run.steps.client?.status,
        { timeout: 60_000 }
      )
      .toBe('done')
    const downloads = path.join(host.userDataDir, 'bots', bot.folder, '.orca', 'browser-downloads')
    expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([])
    expect(existsSync(path.join(host.env.HOME!, '.orca', 'google', 'client.enc'))).toBe(true)
  } finally {
    try {
      await client?.dispose()
    } finally {
      try {
        await launched?.dispose()
      } finally {
        server.close()
      }
    }
  }
})
