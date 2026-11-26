import assert from 'node:assert/strict'
import { expect } from '@stablyai/playwright-test'
import { toRemoteRuntimePtyId } from '../../../src/shared/remote-runtime/remote-runtime-pty-id'
import { rowMenuFixture as fixture, test, workerPaneKey } from './row-menu-proof-fixture'

test('unchanged fallback tab PTY opens; a replacement with no leaf binding is refused', async ({
  proof
}) => {
  const {
    page,
    workspaceId,
    otherWorkspaceId,
    snapshot,
    item,
    gone,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    renderedActiveTab,
    assertServedModules
  } = proof
  await activateOtherWorkspace()
  const terminal = await page.evaluate((workspaceId) => {
    const store = window.__store!
    const id = store.getState().createTab(workspaceId, undefined, undefined, { activate: false }).id
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
  await assertServedModules(false)
})

test('first provider publication keeps Open usable; replacing the chat refuses Open', async ({
  proof
}) => {
  const {
    page,
    workspaceId,
    otherWorkspaceId,
    snapshot,
    item,
    gone,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    renderedActiveTab,
    chatPaneKey,
    seedChat,
    replaceChatEntity,
    assertServedModules
  } = proof
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
      return window.__store!.getState().agentStatusByPaneKey.get(chatPaneKey)?.providerSession?.id
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
  await assertServedModules(false)
})

test('a paired twin arriving after the menu opens refuses Continue in terminal', async ({
  proof
}) => {
  const {
    otherWorkspaceId,
    preparations,
    snapshot,
    menu,
    item,
    gone,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    chatPaneKey,
    seedChat,
    addPairedTwin,
    assertServedModules
  } = proof
  await seedChat()
  await activateOtherWorkspace()
  await openMenu(chatPaneKey)
  const fork = item('Continue in terminal')
  await expect(fork).toBeVisible()
  await addPairedTwin()
  await fork.click()
  await expect(gone).toBeVisible()
  await expect(menu).toBeHidden()
  assert.equal(await activeWorkspace(), otherWorkspaceId)
  assert.equal(await preparations(), 0)
  await snapshot('paired-twin-arrival-refused')
  await assertServedModules(false)
})

for (const stamp of [undefined, 'local'] as const) {
  test(`a detected-only SSH rival hides Fork for a ${stamp ?? 'legacy unstamped'} card`, async ({
    proof
  }) => {
    const {
      preparations,
      snapshot,
      item,
      openMenu,
      activateOtherWorkspace,
      chatPaneKey,
      seedChat,
      addDetectedSshRival,
      assertServedModules
    } = proof
    await seedChat()
    await activateOtherWorkspace()
    await addDetectedSshRival(stamp)
    await openMenu(chatPaneKey)
    await expect(item('Open')).toBeVisible()
    await expect(item('Continue in terminal')).toHaveCount(0)
    assert.equal(await preparations(), 0)
    await snapshot(`detected-ssh-rival-${stamp ?? 'unstamped'}`)
    await assertServedModules(false)
  })
}

test('a detected-only SSH rival arriving after the menu opens refuses preparation', async ({
  proof
}) => {
  const {
    otherWorkspaceId,
    preparations,
    snapshot,
    menu,
    item,
    gone,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    chatPaneKey,
    seedChat,
    addDetectedSshRival,
    assertServedModules
  } = proof
  await seedChat()
  await activateOtherWorkspace()
  await openMenu(chatPaneKey)
  const fork = item('Continue in terminal')
  await expect(fork).toBeVisible()
  await addDetectedSshRival('local')
  await fork.click()
  await expect(gone).toBeVisible()
  await expect(menu).toBeHidden()
  assert.equal(await activeWorkspace(), otherWorkspaceId)
  assert.equal(await preparations(), 0)
  await snapshot('detected-ssh-arrival-refused')
  await assertServedModules(false)
})

test('a stamped local chat without rivals prepares and reveals its terminal fork', async ({
  proof
}) => {
  const {
    page,
    workspaceId,
    preparations,
    snapshot,
    menu,
    item,
    openMenu,
    activateOtherWorkspace,
    activeWorkspace,
    renderedActiveTab,
    chatPaneKey,
    seedChat,
    assertServedModules
  } = proof
  await seedChat()
  await activateOtherWorkspace()
  const before = await page.evaluate(
    (id) => (window.__store!.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    workspaceId
  )
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
  await fork.click()
  await expect.poll(preparations).toBe(1)
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
  await assertServedModules(false)
})

test('unmirrored worker Open sends the tab, leaf and click-time pairing to IPC', async ({
  proof
}) => {
  const { page, workspaceId, calls, snapshot, item, openMenu, addPairedTwin, assertServedModules } =
    proof
  await addPairedTwin()
  await page.evaluate(
    ({ workspaceId, fixture, workerPaneKey, handle }) => {
      window.__store!.getState().setAgentStatus(
        workerPaneKey,
        {
          state: 'working',
          agentType: 'codex',
          prompt: 'Inspect the sample work',
          orchestration: {
            taskId: 'proof-paired-task',
            dispatchId: 'proof-paired-dispatch',
            orchestrationRunId: 'proof-paired-run'
          }
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
      async () => (await calls()).find((call) => call.args.method === 'session.tabs.activate')?.args
    )
    .toMatchObject({
      params: { tabId: 'proof-agent-row-worker', leafId: fixture.workerLeafId },
      expectedEnvironmentPairingRevision: fixture.environment.pairingRevision
    })
  console.log(
    'Paired activation IPC',
    JSON.stringify((await calls()).filter((call) => call.args.method === 'session.tabs.activate'))
  )
  await assertServedModules(true)
})
