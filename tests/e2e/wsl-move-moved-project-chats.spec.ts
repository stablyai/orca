/**
 * After a WSL move commits, the moved project's existing chats stay on this computer (owner
 * decision, option C): the sidebar lists them under a read-only "Moved to <distro> host" entry,
 * while the project's terminals stay with the host and are no longer restored here.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { seedTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import { structuredAgentSessionTabId } from '../../src/shared/structured-agent-session-projection'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import { closeTestJournalHostDatabases } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../src/shared/agent-session-record.test-fixture'

test.use({ seedTestRepo: false })

const GROUP = 'moved-group'
const TERMINAL = 'moved-terminal'
const CHAT_SESSION = 'moved-chat-0001'
const CHAT = structuredAgentSessionTabId(CHAT_SESSION)
const CHAT_LABEL = 'Plan the parser rewrite'
// Visual proof for the PR; outside the repo on purpose.
const PROOF_DIR = process.env.ORCA_D1B7A_PROOF_DIR ?? process.env.ORCA_WSL_USE_HERE_PROOF_DIR

type SessionTabs = {
  tabsByWorktree?: Record<string, unknown[]>
  unifiedTabs?: Record<string, { id: string; contentType: string }[]>
  tabGroups?: Record<string, unknown[]>
  activeGroupIdByWorktree?: Record<string, string>
}

function sessionOf(state: Record<string, unknown>): SessionTabs {
  const session = state.workspaceSession
  if (!session || typeof session !== 'object') {
    throw new Error('Expected a persisted workspace session')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test seeded the profile and checks each optional field at use.
  return session as SessionTabs
}

/** The chat's durable record on this computer, at rest, in the moved project's worktree. */
async function seedChatRecord(userDataDir: string, worktreeId: string): Promise<void> {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: CHAT_SESSION,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
  await seedTestAgentSessionRecordStore(userDataDir, {
    records: [{ ...record, location: { ...record.location, workspaceId: worktreeId } }],
    sessionTabs: [{ tabId: CHAT, sessionId: CHAT_SESSION }]
  })
  closeTestJournalHostDatabases()
}

/** A terminal and a native chat in the moved project, as a session saved before the move. */
function seedMovedProjectTabs(userDataDir: string, worktreeId: string): void {
  mutateStoppedProfileState(userDataDir, (state) => {
    const session = sessionOf(state)
    const tab = (id: string, contentType: string, label: string, sortOrder: number) => ({
      id,
      entityId: contentType === 'agent-session' ? CHAT_SESSION : id,
      groupId: GROUP,
      worktreeId,
      contentType,
      label,
      customLabel: contentType === 'agent-session' ? label : null,
      color: null,
      sortOrder,
      createdAt: sortOrder,
      ...(contentType === 'agent-session' ? { agentSessionAgent: 'claude' } : {})
    })
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [worktreeId]: [
        {
          id: TERMINAL,
          ptyId: null,
          worktreeId,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
    session.unifiedTabs = {
      ...session.unifiedTabs,
      [worktreeId]: [
        tab(TERMINAL, 'terminal', 'Shell', 0),
        tab(CHAT, 'agent-session', CHAT_LABEL, 1)
      ]
    }
    session.tabGroups = {
      ...session.tabGroups,
      [worktreeId]: [{ id: GROUP, worktreeId, activeTabId: CHAT, tabOrder: [TERMINAL, CHAT] }]
    }
    session.activeGroupIdByWorktree = { ...session.activeGroupIdByWorktree, [worktreeId]: GROUP }
  })
}

async function addRepo(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (path) => {
    const result = await window.api.repos.add({ path })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
}

async function movedTabs(page: Page, worktreeId: string) {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return {
      unified: (state.unifiedTabsByWorktree[id] ?? []).map((tab) => tab.id),
      terminals: (state.tabsByWorktree[id] ?? []).map((tab) => tab.id),
      activeWorktreeId: state.activeWorktreeId
    }
  }, worktreeId)
}

test("a moved project's existing chats stay listed and openable on this computer", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-moved-chats-'))
  const repoPath = join(root, 'moved-repo')
  mkdirSync(repoPath)
  const gitIdentity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', [...gitIdentity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const repoId = await addRepo(launched.page, repoPath)
    const worktreeId = `${repoId}::${realpathSync(repoPath)}`
    await session.close(launched.app)
    launched = undefined

    seedMovedProjectTabs(session.userDataDir, worktreeId)
    await seedChatRecord(session.userDataDir, worktreeId)
    seedWslMoveCutover(
      session.userDataDir,
      wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: [repoId] })
    )

    launched = await session.launch()
    const { page } = launched
    await waitForSessionReady(page)
    // Session History's reveal: the host reads the chat's record and republishes its tab into the
    // moved project's worktree, which only the retained entry lists.
    const revealed = await page.evaluate(
      (sessionId) =>
        window.api.runtime.call({ method: 'agentSession.reveal', params: { sessionId } }),
      CHAT_SESSION
    )
    expect(revealed).toMatchObject({ ok: true, result: { ok: true, workspaceId: worktreeId } })
    const entry = page.getByTestId('wsl-moved-project')
    await expect(entry).toBeVisible({ timeout: 30_000 })
    await expect(entry).toContainText('moved-repo')
    await expect(entry).toContainText('Moved to Ubuntu host')
    const chat = entry.getByTestId('wsl-moved-chat')
    await expect(chat).toHaveCount(1)
    // Read-only: the chat and "use on this computer again" are the entry's only controls.
    await expect(entry.getByRole('button')).toHaveCount(2)
    // The project's terminal lives on the host now; only its chat is here.
    expect(await movedTabs(page, worktreeId)).toMatchObject({ unified: [CHAT], terminals: [] })
    if (PROOF_DIR) {
      mkdirSync(PROOF_DIR, { recursive: true })
      await page.screenshot({ path: join(PROOF_DIR, 'moved-project-sidebar.png') })
    }

    await chat.click()
    await expect
      .poll(async () => (await movedTabs(page, worktreeId)).activeWorktreeId)
      .toBe(worktreeId)
    await expect(chat).toHaveAttribute('data-current', 'true')
    if (PROOF_DIR) {
      await page.screenshot({ path: join(PROOF_DIR, 'moved-project-chat-open.png') })
    }
    await session.close(launched.app)
    launched = undefined

    // The freeze kept the slept terminal for a downgrade, and the chat tab beside it.
    const persisted = sessionOf(readPersistedProfileState(session.userDataDir))
    expect(persisted.tabsByWorktree?.[worktreeId]).toHaveLength(1)
    expect(persisted.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual([TERMINAL, CHAT])
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('"Use on this computer again" brings a moved project back as it was before the move', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-use-here-'))
  const repoPath = join(root, 'moved-repo')
  mkdirSync(repoPath)
  const gitIdentity = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', [...gitIdentity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: repoPath
  })
  // The escape hatch, like every WSL move action, answers only behind the internal gate.
  const session = createRestartSession(testInfo, { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const repoId = await addRepo(launched.page, repoPath)
    const worktreeId = `${repoId}::${realpathSync(repoPath)}`
    await session.close(launched.app)
    launched = undefined

    seedMovedProjectTabs(session.userDataDir, worktreeId)
    await seedChatRecord(session.userDataDir, worktreeId)
    seedWslMoveCutover(
      session.userDataDir,
      wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: [repoId] })
    )

    launched = await session.launch()
    const { page } = launched
    await waitForSessionReady(page)
    await page.evaluate(
      (sessionId) =>
        window.api.runtime.call({ method: 'agentSession.reveal', params: { sessionId } }),
      CHAT_SESSION
    )
    const entry = page.getByTestId('wsl-moved-project')
    await expect(entry).toBeVisible({ timeout: 30_000 })
    const listed = () =>
      page.evaluate((id) => window.__store!.getState().repos.some((repo) => repo.id === id), repoId)
    expect(await listed()).toBe(false)

    await entry.getByTestId('wsl-moved-use-here').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Your code is not affected')
    await expect(dialog).toContainText('stays on the Ubuntu host until you remove it there')
    if (PROOF_DIR) {
      mkdirSync(PROOF_DIR, { recursive: true })
      // Settled, so the proof shows the dialog rather than its fade-in.
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
      )
      await page.screenshot({ path: join(PROOF_DIR, 'use-here-confirm.png') })
    }
    // Main reloads the window so the project's whole pre-move session hydrates from disk.
    const reloaded = page.waitForEvent('load')
    await dialog.getByRole('button', { name: 'Use on this computer' }).click()
    await reloaded
    await waitForSessionReady(page)

    // The retained row lists again, and the read-only entry goes away.
    await expect.poll(listed, { timeout: 30_000 }).toBe(true)
    await expect(page.getByTestId('wsl-moved-project')).toHaveCount(0)
    if (PROOF_DIR) {
      await page.screenshot({ path: join(PROOF_DIR, 'use-here-done.png') })
    }
    await session.close(launched.app)
    launched = undefined

    // The pre-move session came back with it: the slept terminal and the chat beside it.
    const persisted = sessionOf(readPersistedProfileState(session.userDataDir))
    expect(persisted.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual([TERMINAL, CHAT])
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
