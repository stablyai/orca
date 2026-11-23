import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../desktop/renderer-probes/store'

function writeClaudeStub(stubDir: string): { command: string; inputsLog: string } {
  fs.mkdirSync(stubDir, { recursive: true })
  const script = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'structured-claude-stub.cjs')
  const launchLog = path.join(stubDir, 'launches.jsonl')
  const inputsLog = path.join(stubDir, 'launches-inputs.jsonl')
  const command = path.join(stubDir, 'claude')
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  fs.writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(launchLog)} "$@"\n`
  )
  fs.chmodSync(command, 0o755)
  return { command, inputsLog }
}

function readStubInputs(inputsLog: string): string[] {
  if (!fs.existsSync(inputsLog)) {
    return []
  }
  return fs
    .readFileSync(inputsLog, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

test('bot work-target picker keyboard/IME/autocomplete boundaries and observable opens-next-turn delivery', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-work-target-e2e-'))
  const { command: claudeStub, inputsLog } = writeClaudeStub(stubDir)
  const shortcut = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P'

  try {
    // Wire the stream-json Claude stub and Steer-default delivery mode, then open a real Bot Home chat.
    const setup = await orcaPage.evaluate(async (stubCommand) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      await store.getState().updateSettings({
        uiLanguage: 'en',
        nativeChatProviders: { claude: true, codex: true },
        agentCmdOverrides: { claude: stubCommand }
      })

      const created = await window.api.runtime.call({
        method: 'bots.create',
        params: { name: 'TargetBot', agent: 'claude', takingOver: true }
      })
      if (!created.ok) {
        throw new Error(`bots.create failed: ${JSON.stringify(created)}`)
      }
      const createdResult = created.result
      const botValue =
        typeof createdResult === 'object' && createdResult !== null && 'bot' in createdResult
          ? createdResult.bot
          : null
      if (
        typeof botValue !== 'object' ||
        botValue === null ||
        !('id' in botValue) ||
        typeof botValue.id !== 'string' ||
        !('folderWorkspaceId' in botValue) ||
        typeof botValue.folderWorkspaceId !== 'string'
      ) {
        throw new Error(`Unexpected bots.create result: ${JSON.stringify(createdResult)}`)
      }
      const bot = { id: botValue.id, folderWorkspaceId: botValue.folderWorkspaceId }

      const opened = await window.api.runtime.call({
        method: 'bots.chat.open',
        params: { botId: bot.id }
      })
      if (!opened.ok) {
        throw new Error(`bots.chat.open failed: ${JSON.stringify(opened)}`)
      }

      // Seed a connected SSH Git repo + existing worktree in renderer state to exercise the disabled SSH project boundary.
      const state = store.getState()
      const seededRepo = state.repos[0]
      if (!seededRepo) {
        throw new Error('Expected seeded local repo')
      }
      store.setState((prev) => ({
        repos: [
          ...prev.repos,
          {
            id: 'repo-e2e-ssh',
            path: '/srv/edge-gateway',
            displayName: 'edge-gateway',
            badgeColor: '#6366f1',
            addedAt: Date.now(),
            kind: 'git',
            connectionId: 'ssh-e2e-build'
          }
        ],
        worktreesByRepo: {
          ...prev.worktreesByRepo,
          'repo-e2e-ssh': [
            {
              id: 'repo-e2e-ssh::/srv/edge-gateway',
              repoId: 'repo-e2e-ssh',
              path: '/srv/edge-gateway',
              head: 'abc123',
              branch: 'refs/heads/main',
              isBare: false,
              isMainWorktree: true,
              displayName: 'main',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: Date.now(),
              connectionId: 'ssh-e2e-build',
              instanceId: 'inst-ssh-main'
            }
          ]
        },
        sshTargetLabels: new Map([
          ...prev.sshTargetLabels.entries(),
          ['ssh-e2e-build', 'Build SSH']
        ]),
        sshConnectionStates: new Map([
          ...prev.sshConnectionStates.entries(),
          [
            'ssh-e2e-build',
            {
              targetId: 'ssh-e2e-build',
              status: 'connected' as const,
              error: null,
              reconnectAttempt: 0
            }
          ]
        ])
      }))

      const botHomeKey = `folder:${bot.folderWorkspaceId}`
      await store.getState().fetchFolderWorkspacesForAllHosts()
      store.getState().setActiveWorktree(botHomeKey)
      return {
        seededRepoName: seededRepo.displayName
      }
    }, claudeStub)

    const composer = orcaPage.getByRole('textbox').first()
    const pickerTrigger = orcaPage.locator('[data-work-target-trigger]')
    await expect(composer).toBeVisible({ timeout: 20_000 })
    await expect(pickerTrigger).toBeVisible({ timeout: 20_000 })

    // 1) Keyboard shortcut opens picker & focuses search; Escape closes & returns focus; Korean layout KeyP still opens.
    await composer.click()
    await orcaPage.keyboard.press(shortcut)
    const searchInput = orcaPage.getByRole('combobox', {
      name: 'Filter projects and workspaces…'
    })
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
    await orcaPage.keyboard.press('Escape')
    await expect(searchInput).toHaveCount(0)
    await expect(composer).toBeFocused()

    await composer.evaluate((element, isMac) => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ㅔ',
          code: 'KeyP',
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    }, process.platform === 'darwin')
    await expect(searchInput).toBeVisible()

    // 2) SSH Git project is disabled ("Pick a workspace") while its child SSH worktree remains selectable.
    const listbox = orcaPage.getByRole('listbox', { name: 'Target project or workspace' })
    const sshProjectOption = listbox.locator(
      '[data-work-target-row-id="project:ssh:ssh-e2e-build:repo-e2e-ssh"]'
    )
    const sshChildOption = listbox.locator(
      '[data-work-target-row-id="workspace:ssh:ssh-e2e-build:repo-e2e-ssh::/srv/edge-gateway"]'
    )
    await expect(sshProjectOption).toHaveAttribute('aria-disabled', 'true')
    await expect(sshProjectOption).toContainText('Pick a workspace')
    await expect(sshChildOption).not.toHaveAttribute('aria-disabled', 'true')

    // 3) IME Enter inside picker search must not select a row or close the popover.
    await searchInput.fill('e2e-secondary')
    await searchInput.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '에' }))
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '에' }))
    })
    await expect(searchInput).toBeVisible()

    // Selecting the filtered local worktree via Enter arms the composer chip and returns focus.
    await orcaPage.keyboard.press('Enter')
    await expect(searchInput).toHaveCount(0)
    const targetChip = orcaPage.locator('[data-work-target-chip]')
    await expect(targetChip).toContainText('e2e-secondary')
    await expect(composer).toBeFocused()

    // 4) `/` slash autocomplete & `@` mentions coexist cleanly with an armed target; Ctrl+Shift+P dismisses slash menu.
    await orcaPage.keyboard.type('/')
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    await orcaPage.keyboard.press(shortcut)
    await expect(searchInput).toBeVisible()
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await orcaPage.keyboard.press('Escape')
    await expect(composer).toBeFocused()
    await orcaPage.keyboard.press('Backspace')
    await orcaPage.keyboard.type('@')
    await expect(targetChip).toContainText('e2e-secondary')
    await orcaPage.keyboard.press('Backspace')

    // 5) IME Enter inside composer must not submit while composing.
    await orcaPage.keyboard.type('ime guard check')
    await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '한' }))
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }))
    })
    expect(readStubInputs(inputsLog)).toHaveLength(0)

    // Clear the draft & chip, then start an active untargeted "slow" turn.
    await orcaPage.getByRole('button', { name: 'Clear selected target' }).click()
    await expect(targetChip).toHaveCount(0)
    await composer.click()
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await orcaPage.keyboard.press('Backspace')
    await orcaPage.keyboard.type('first turn slow')
    await orcaPage.keyboard.press('Enter')

    await expect.poll(() => readStubInputs(inputsLog).length, { timeout: 20_000 }).toBe(1)
    expect(readStubInputs(inputsLog)[0]).toContain('first turn slow')

    // 6) While turn 1 is active under Steer-default, a targeted message must queue (never steer or strip target).
    await composer.click()
    await orcaPage.keyboard.press(shortcut)
    await expect(searchInput).toBeVisible()
    await searchInput.fill('e2e-secondary')
    await orcaPage.keyboard.press('Enter')
    await expect(targetChip).toContainText('e2e-secondary')

    await orcaPage.keyboard.type('targeted while active')
    await orcaPage.keyboard.press('Enter')

    // Chip clears for next draft; queued card shows target tag and offers no active-turn Send-now steer button.
    await expect(targetChip).toHaveCount(0)
    const queuedCard = orcaPage.locator('[data-queued-message-id]').first()
    await expect(queuedCard).toBeVisible({ timeout: 10_000 })
    await expect(queuedCard).toContainText('targeted while active')
    await expect(queuedCard.locator('[data-work-target-tag]')).toContainText('e2e-secondary')
    await expect(queuedCard.locator('[data-queued-message-send]')).toHaveCount(0)
    expect(readStubInputs(inputsLog)).toHaveLength(1)

    // Stop the active turn, then send the queued card once idle -> stub receives <orca_context> with exact identity!
    await orcaPage.getByRole('button', { name: /Stop/i }).first().click()
    const sendQueuedButton = queuedCard.locator('[data-queued-message-send]')
    await expect(sendQueuedButton).toBeVisible({ timeout: 15_000 })
    await sendQueuedButton.click()

    await expect.poll(() => readStubInputs(inputsLog).length, { timeout: 20_000 }).toBe(2)
    const turn2Payload = readStubInputs(inputsLog)[1] ?? ''
    expect(turn2Payload).toContain('<orca_context>')
    expect(turn2Payload).toContain('e2e-secondary')
    expect(turn2Payload).toContain(setup.seededRepoName)
    expect(turn2Payload).toContain('--worktree identity:wt2:local:')
    expect(turn2Payload).toContain('targeted while active')

    // Observable sent user message renders the target tag; subsequent untargeted turn omits target context.
    await expect(
      orcaPage.locator('[data-work-target-tag]').filter({ hasText: 'e2e-secondary' }).first()
    ).toBeVisible({ timeout: 15_000 })

    // Wait for turn 2 to complete (~500ms in stub), then send a plain untargeted message.
    await expect(orcaPage.getByRole('button', { name: /Stop/i })).toHaveCount(0, {
      timeout: 15_000
    })
    await composer.click()
    await orcaPage.keyboard.type('plain untargeted turn')
    await orcaPage.keyboard.press('Enter')

    await expect.poll(() => readStubInputs(inputsLog).length, { timeout: 20_000 }).toBe(3)
    const turn3Payload = readStubInputs(inputsLog)[2] ?? ''
    expect(turn3Payload).toContain('plain untargeted turn')
    expect(turn3Payload).not.toContain('--worktree identity:')
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true })
  }
})
