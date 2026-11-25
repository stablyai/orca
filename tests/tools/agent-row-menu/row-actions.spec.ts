import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../../e2e/desktop/electron-fixtures/orca-app'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { toRuntimeExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { toRemoteRuntimePtyId } from '../../../src/shared/remote-runtime/remote-runtime-pty-id'

const fixture = {
  chatTabId: 'proof-agent-row-chat',
  chatSessionId: '77777777-7777-4777-8777-777777777777',
  providerSessionId: '88888888-8888-4888-8888-888888888888',
  replacementChatId: '66666666-6666-4666-8666-666666666666',
  forkSessionId: '11111111-1111-4111-8111-111111111111',
  workerTabId: 'web-terminal-proof-agent-row-worker',
  workerLeafId: '99999999-9999-4999-8999-999999999999',
  environment: {
    id: 'proof-paired-host',
    name: 'Paired proof host',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 7,
    lastUsedAt: 1,
    runtimeId: 'proof-paired-runtime',
    pairedDeviceId: 'proof-device',
    endpoints: [
      {
        id: 'proof-endpoint',
        kind: 'websocket' as const,
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:9'
      }
    ],
    preferredEndpointId: 'proof-endpoint',
    hostKeyFingerprint: 'proof-host-key'
  }
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const hostId = toRuntimeExecutionHostId(fixture.environment.id)
const workerPaneKey = `${fixture.workerTabId}:${fixture.workerLeafId}`

test('agent row Open and Continue in terminal use the target captured by the menu', async ({
  orcaPage: page,
  electronApp,
  seededRepoPath
}, testInfo) => {
  const head = git('rev-parse', 'HEAD')
  const base = git('merge-base', 'origin/main', head)
  assert.equal(head, process.env.ORCA_ROW_MENU_HEAD)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(Boolean(process.env.SKIP_BUILD), false)
  const root = realpathSync(process.cwd())
  const artifacts = Object.fromEntries(
    ['main', 'preload', 'renderer'].flatMap((target) => {
      const dir = join(root, 'out', target)
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:[cm]?js|html|css)$/.test(entry.name))
        .map((entry) => {
          const path = join(entry.parentPath, entry.name)
          return [relative(root, path), digest(path)]
        })
    })
  )
  const identity = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const preferences =
      'getLastWebPreferences' in contents && typeof contents.getLastWebPreferences === 'function'
        ? (contents.getLastWebPreferences() as { preload?: string })
        : null
    return { appPath: app.getAppPath(), preload: preferences?.preload, versions: process.versions }
  })
  assert.equal(realpathSync(identity.appPath), root)
  assert.ok(identity.preload && artifacts[relative(root, identity.preload)])
  assert.ok(artifacts[join('out', 'main', 'index.js')])
  const renderer = fileURLToPath(page.url())
  assert.ok(artifacts[relative(root, renderer)])
  const rendererScripts = new Set<string>()
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('file:')) {
      rendererScripts.add(relative(root, fileURLToPath(url)))
    }
  })
  await cdp.send('Debugger.enable')
  await page.setViewportSize({ width: 1600, height: 1000 })
  console.log(
    JSON.stringify({ head, base, viewport: '1600x1000', build: 'electron-vite build --mode e2e' })
  )
  console.log(
    'The IPC fixture returns invented preparation and paired success. No paired host receives these calls.'
  )

  const { workspaceId, otherWorkspaceId, repoId } = await page.evaluate((repoPath) => {
    const store = window.__store!
    const state = store.getState()
    const repo = state.repos.find((candidate) => candidate.path === repoPath)!
    const worktrees = state.worktreesByRepo[repo.id]!
    const main = worktrees.find((worktree) => worktree.isMainWorktree)!
    const other = worktrees.find((worktree) => worktree.id !== main.id)!
    state.setSidebarWidth(276)
    state.setAgentActivityDisplayMode('full')
    if (state.settings) {
      store.setState({
        settings: {
          ...state.settings,
          uiLanguage: 'en',
          agentCmdOverrides: { ...state.settings.agentCmdOverrides, codex: 'echo' }
        }
      })
    }
    return { workspaceId: main.id, otherWorkspaceId: other.id, repoId: repo.id }
  }, seededRepoPath)
  await electronApp.evaluate(
    ({ ipcMain }, config) => {
      type Request = { selector?: string; method?: string; sourceChat?: { workspaceId?: string } }
      type Handler = (event: unknown, args: Request) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers
      const calls: { channel: string; args: Request }[] = []
      Object.assign(globalThis, { rowMenuProofCalls: calls })
      const localPrepare = handlers.get('aiVault:prepareSessionResume')!
      handlers.set('aiVault:prepareSessionResume', (event, args) => {
        if (args.sourceChat?.workspaceId !== config.workspaceId) {
          return localPrepare(event, args)
        }
        calls.push({ channel: 'local prepare', args })
        return {
          cliForkSource: {
            agent: 'codex',
            sourceAgent: 'codex',
            sessionId: config.forkSessionId,
            filePath: `${config.repoPath}/fixture-transcript.jsonl`,
            cwd: config.repoPath,
            codexHome: null,
            executionHostPlatform: process.platform
          },
          forkedSession: { agent: 'codex', sessionId: config.forkSessionId }
        }
      })
      const pairedCall = handlers.get('runtimeEnvironments:call')!
      handlers.set('runtimeEnvironments:call', (event, args) => {
        if (args.selector !== config.environmentId) {
          return pairedCall(event, args)
        }
        calls.push({ channel: 'paired call', args })
        const results: Record<string, unknown> = {
          'status.get': { runtimeId: 'proof-paired-runtime', capabilities: [] },
          'session.tabs.list': { tabs: [] },
          'session.tabs.activate': { activated: true },
          'worktree.activate': { activated: true }
        }
        const result = results[args.method ?? ''] ?? {}
        return { id: 'fixture', ok: true, result, _meta: { runtimeId: 'proof-paired-runtime' } }
      })
    },
    {
      workspaceId,
      repoPath: seededRepoPath,
      forkSessionId: fixture.forkSessionId,
      environmentId: fixture.environment.id
    }
  )
  const calls = () =>
    electronApp.evaluate(
      () =>
        Reflect.get(globalThis, 'rowMenuProofCalls') as {
          channel: string
          args: {
            method?: string
            params?: { tabId?: string; leafId?: string }
            expectedEnvironmentPairingRevision?: number
          }
        }[]
    )
  const snapshot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  const sidebar = page.locator('[data-worktree-sidebar]')
  const menu = page.getByRole('menu', { name: /^Agent: / })
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true })
  const gone = page.getByText('This agent is no longer open.', { exact: true })
  const openMenu = async (paneKey: string) => {
    await sidebar
      .locator(`[data-agent-row-pane-key="${paneKey}"]`)
      .first()
      .click({ button: 'right' })
    await expect(menu).toBeVisible()
  }
  const activateOtherWorkspace = () =>
    page.evaluate((id) => {
      window.__store!.getState().setActiveWorktree(id, 'local')
    }, otherWorkspaceId)
  const activeWorkspace = () => page.evaluate(() => window.__store!.getState().activeWorktreeId)
  const renderedActiveTab = (id: string) =>
    page.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"][data-active="true"]`)
  const chatPaneKey = structuredAgentSessionPaneKey(fixture.chatTabId, fixture.chatSessionId)
  const seedChat = () =>
    page.evaluate(
      ({ workspaceId, chatPaneKey, fixture }) => {
        const store = window.__store!
        const state = store.getState()
        state.createUnifiedTab(workspaceId, 'agent-session', {
          id: fixture.chatTabId,
          entityId: fixture.chatSessionId,
          label: 'Proof planning chat',
          agentSessionAgent: 'codex',
          executionHostId: 'local',
          activate: false
        })
        state.setAgentStatus(
          chatPaneKey,
          {
            state: 'working',
            agentType: 'codex',
            prompt: 'Plan the sample work'
          },
          'Proof planning chat',
          undefined,
          { tabId: fixture.chatTabId, worktreeId: workspaceId }
        )
      },
      { workspaceId, chatPaneKey, fixture }
    )
  const replaceChatEntity = (entityId: string) =>
    page.evaluate(
      ({ workspaceId, tabId, entityId }) => {
        const store = window.__store!
        store.setState((state) => ({
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [workspaceId]: state.unifiedTabsByWorktree[workspaceId]!.map((tab) =>
              tab.id === tabId ? { ...tab, entityId } : tab
            )
          }
        }))
      },
      { workspaceId, tabId: fixture.chatTabId, entityId }
    )
  const setTwin = (present: boolean) =>
    page.evaluate(
      ({ workspaceId, repoId, hostId, environment, present }) => {
        const store = window.__store!
        if (present) {
          store.getState().setRuntimeEnvironments([environment])
        }
        store.setState((state) => {
          const worktrees = state.worktreesByRepo[repoId]!.filter(
            (worktree) => worktree.hostId !== hostId
          )
          const local = worktrees.find((worktree) => worktree.id === workspaceId)!
          return {
            worktreesByRepo: {
              ...state.worktreesByRepo,
              [repoId]: present
                ? [
                    ...worktrees,
                    {
                      ...local,
                      hostId,
                      runtimeOwnerEnvironmentId: environment.id,
                      displayName: 'Paired proof workspace'
                    }
                  ]
                : worktrees
            }
          }
        })
      },
      { workspaceId, repoId, hostId, environment: fixture.environment, present }
    )

  try {
    await test.step('unchanged fallback tab PTY opens; a replacement with no leaf binding is refused', async () => {
      await activateOtherWorkspace()
      const terminal = await page.evaluate((workspaceId) => {
        const store = window.__store!
        const id = store
          .getState()
          .createTab(workspaceId, undefined, undefined, { activate: false }).id
        const state = store.getState()
        const layout = state.terminalLayoutsByTabId[id]!
        const paneKey = `${id}:${layout.activeLeafId}`
        store.setState({
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            [id]: { ...layout, ptyIdsByLeafId: {} }
          },
          ptyIdsByTabId: { ...state.ptyIdsByTabId, [id]: ['proof-pty-before'] }
        })
        state.setAgentStatus(
          paneKey,
          { state: 'working', agentType: 'codex', prompt: 'Proof terminal agent' },
          'Proof terminal agent',
          undefined,
          { tabId: id, worktreeId: workspaceId }
        )
        return { id, paneKey }
      }, workspaceId)
      await openMenu(terminal.paneKey)
      await expect(item('Open')).toBeVisible()
      await expect(item('Copy ID')).toHaveCount(0)
      await page.evaluate(({ id }) => {
        const store = window.__store!
        store.setState((state) => ({
          ptyIdsByTabId: { ...state.ptyIdsByTabId, [id]: ['proof-pty-after'] }
        }))
      }, terminal)
      await item('Open').click()
      await expect(gone).toBeVisible()
      assert.equal(await activeWorkspace(), otherWorkspaceId)
      await expect(renderedActiveTab(terminal.id)).toHaveCount(0)
      await snapshot('fallback-pty-replaced')

      await openMenu(terminal.paneKey)
      await item('Open').click()
      await expect(renderedActiveTab(terminal.id)).toBeVisible()
      await snapshot('fallback-pty-unchanged')
    })

    await test.step('first provider publication keeps Open usable; replacing the chat refuses Open', async () => {
      await seedChat()
      await activateOtherWorkspace()
      await openMenu(chatPaneKey)
      const before = await page.evaluate(
        (key) => window.__store!.getState().agentStatusByPaneKey.get(key)?.providerSession ?? null,
        chatPaneKey
      )
      assert.equal(before, null)
      const published = await page.evaluate(
        ({ workspaceId, chatPaneKey, fixture }) => {
          const state = window.__store!.getState()
          state.setAgentStatus(
            chatPaneKey,
            {
              state: 'working',
              agentType: 'codex',
              prompt: 'Plan the sample work'
            },
            'Proof planning chat',
            undefined,
            { tabId: fixture.chatTabId, worktreeId: workspaceId },
            {
              providerSession: { key: 'session_id', id: fixture.providerSessionId }
            }
          )
          return window.__store!.getState().agentStatusByPaneKey.get(chatPaneKey)?.providerSession
            ?.id
        },
        { workspaceId, chatPaneKey, fixture }
      )
      assert.equal(published, fixture.providerSessionId)
      await item('Open').click()
      await expect(renderedActiveTab(fixture.chatTabId)).toBeVisible()
      await snapshot('chat-first-provider-id')

      await activateOtherWorkspace()
      await expect(gone).toBeHidden()
      await openMenu(chatPaneKey)
      await replaceChatEntity(fixture.replacementChatId)
      await item('Open').click()
      await expect(gone).toBeVisible()
      assert.equal(await activeWorkspace(), otherWorkspaceId)
      await snapshot('chat-entity-replaced')
    })

    await test.step('a twin arriving after opening refuses Continue in terminal; the eligible chat prepares a fork', async () => {
      await replaceChatEntity(fixture.chatSessionId)
      await expect(gone).toBeHidden()
      await openMenu(chatPaneKey)
      const fork = item('Continue in terminal')
      await expect(fork).toBeVisible()
      await snapshot('eligible-local-chat-menu')
      await item('Workspace').hover()
      await expect(page.getByRole('menuitem', { name: 'Edit Details…', exact: true })).toBeVisible()
      await snapshot('agent-workspace-submenu')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await openMenu(chatPaneKey)
      await setTwin(true)
      await fork.click()
      await expect(gone).toBeVisible()
      assert.equal(await activeWorkspace(), otherWorkspaceId)
      assert.equal(
        (await calls()).filter(
          (call) =>
            call.channel === 'local prepare' || call.args.method === 'aiVault.prepareSessionResume'
        ).length,
        0
      )
      await snapshot('twin-arrival-refused')

      await setTwin(false)
      const before = await page.evaluate(
        (id) => (window.__store!.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
        workspaceId
      )
      await openMenu(chatPaneKey)
      await fork.click()
      await expect
        .poll(async () => (await calls()).filter((call) => call.channel === 'local prepare').length)
        .toBe(1)
      await expect(menu).toBeHidden()
      assert.equal(await activeWorkspace(), workspaceId)
      const newTab = await page.evaluate(
        ({ workspaceId, before }) =>
          window
            .__store!.getState()
            .tabsByWorktree[workspaceId]?.find((tab) => !before.includes(tab.id))?.id,
        { workspaceId, before }
      )
      assert.ok(newTab)
      await expect(renderedActiveTab(newTab)).toBeVisible()
      await snapshot('eligible-fork-revealed')
    })

    await test.step('unmirrored worker Open sends the tab, leaf and click-time pairing to IPC', async () => {
      await setTwin(true)
      await page.evaluate(
        ({ workspaceId, fixture, workerPaneKey, handle }) => {
          window.__store!.getState().setAgentStatus(
            workerPaneKey,
            {
              state: 'working',
              agentType: 'codex',
              prompt: 'Inspect the sample work',
              orchestration: { role: 'worker', runId: 'proof-paired-run' }
            },
            'Paired proof worker',
            undefined,
            {
              tabId: fixture.workerTabId,
              worktreeId: workspaceId,
              terminalHandle: handle,
              connectionId: fixture.environment.id
            }
          )
        },
        {
          workspaceId,
          fixture,
          workerPaneKey,
          handle: toRemoteRuntimePtyId('proof-worker', fixture.environment.id)
        }
      )
      await openMenu(workerPaneKey)
      await snapshot('paired-worker-menu')
      await item('Open').click()
      await expect
        .poll(
          async () =>
            (await calls()).find((call) => call.args.method === 'session.tabs.activate')?.args
        )
        .toMatchObject({
          params: { tabId: 'proof-agent-row-worker', leafId: fixture.workerLeafId },
          expectedEnvironmentPairingRevision: fixture.environment.pairingRevision
        })
      console.log(
        'Paired activation IPC',
        JSON.stringify(
          (await calls()).filter((call) => call.args.method === 'session.tabs.activate')
        )
      )
    })
  } finally {
    const loadedRendererScripts = Object.fromEntries(
      [...rendererScripts].sort().map((path) => [path, artifacts[path]])
    )
    writeFileSync(
      testInfo.outputPath('build-inputs.json'),
      `${JSON.stringify(
        {
          head,
          base,
          tree: git('rev-parse', 'HEAD^{tree}'),
          node: process.version,
          driver: digest(__filename),
          config: digest(join(root, 'tests/tools/agent-row-menu/proof.config.ts')),
          lockfile: digest(join(root, 'pnpm-lock.yaml')),
          identity,
          artifacts,
          loadedRendererScripts
        },
        null,
        2
      )}\n`
    )
    assert.ok(Object.keys(loadedRendererScripts).filter((path) => path in artifacts).length > 1)
    assert.ok(Object.keys(artifacts).every((path) => digest(join(root, path)) === artifacts[path]))
    assert.equal(git('rev-parse', 'HEAD'), head)
    assert.equal(git('status', '--porcelain'), '')
    await cdp.detach()
  }
})
