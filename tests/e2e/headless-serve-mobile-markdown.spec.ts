/**
 * A phone reads and saves a Markdown tab on a headless server, from the server's own disk.
 *
 * A headless host lists the editor tabs its saved session holds (a converted SSH host's move
 * carries them in). With no window there is no editor to relay through, so the server answers
 * from the file itself and saves with a compare against the version the phone last read.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../src/shared/mobile-markdown-document'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  orcadNodeExecutable,
  pairedClient,
  startHeadlessOracleHost,
  type HeadlessHostKind
} from './helpers/headless-layout-oracle-hosts'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Saves an open Markdown editor for the worktree, as a desktop or a move leaves it. */
function saveMarkdownEditor(userDataDir: string, worktreeId: string, filePath: string): void {
  mutateStoppedProfileState(userDataDir, (state) => {
    const session = state.workspaceSession
    if (!isRecord(session)) {
      throw new Error('The profile has no workspace session')
    }
    session.openFilesByWorktree = {
      ...(isRecord(session.openFilesByWorktree) ? session.openFilesByWorktree : {}),
      [worktreeId]: [
        {
          filePath,
          relativePath: path.basename(filePath),
          worktreeId,
          language: 'markdown',
          runtimeEnvironmentId: null
        }
      ]
    }
  })
}

async function markdownTabId(phone: RuntimeClient, worktree: string): Promise<string> {
  let tabId = ''
  await expect
    .poll(
      async () => {
        const { result } = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
          worktree
        })
        tabId = result.tabs.find((tab) => tab.type === 'markdown')?.id ?? ''
        return tabId
      },
      { timeout: 30_000, message: 'the server never listed the saved Markdown tab' }
    )
    .not.toBe('')
  return tabId
}

async function readTab(phone: RuntimeClient, worktree: string, tabId: string) {
  return (await phone.call<RuntimeMarkdownReadTabResult>('markdown.readTab', { worktree, tabId }))
    .result
}

const HOSTS: HeadlessHostKind[] = ['electron', 'orcad']

for (const kind of HOSTS) {
  test(`a phone reads and saves a Markdown tab on a headless ${kind} server`, async () => {
    // Why skip in CI too: only the orcad mode-switch job builds out/orcad.
    test.skip(kind === 'orcad' && !orcadNodeExecutable(), 'out/orcad is not built')
    test.setTimeout(240_000)
    const host = await startHeadlessOracleHost(kind)
    try {
      const cli = cliClient(host)
      const phone = pairedClient(host, 'phone')
      const worktreeId = await addRepoWorktree(host, cli)
      const worktree = `id:${worktreeId}`
      const listed = await cli.call<{ worktrees: { id: string; path: string }[] }>(
        'worktree.list',
        { repo: `id:${worktreeId.split('::')[0]}` }
      )
      const repoPath = listed.result.worktrees.find((entry) => entry.id === worktreeId)!.path
      const filePath = path.join(repoPath, 'README.md')
      await host.restart({
        whileStopped: () => saveMarkdownEditor(host.userDataDir, worktreeId, filePath)
      })

      const tabId = await markdownTabId(phone, worktree)
      const read = await readTab(phone, worktree, tabId)
      expect(read).toMatchObject({
        tabId,
        filePath,
        content: 'layout oracle\n',
        source: 'file',
        isDirty: false,
        editable: true
      })

      const saved = (
        await phone.call<RuntimeMarkdownSaveTabResult>('markdown.saveTab', {
          worktree,
          tabId,
          baseVersion: read.version,
          content: '# from the phone\n'
        })
      ).result
      expect(saved).toMatchObject({ tabId, isDirty: false, content: '# from the phone\n' })
      expect(readFileSync(filePath, 'utf8')).toBe('# from the phone\n')

      // A save over a version the disk no longer holds is refused, and the disk keeps its bytes.
      writeFileSync(filePath, '# edited on the server\n')
      await expect(
        phone.call('markdown.saveTab', {
          worktree,
          tabId,
          baseVersion: saved.version,
          content: '# stale phone edit\n'
        })
      ).rejects.toThrow('conflict')
      expect(readFileSync(filePath, 'utf8')).toBe('# edited on the server\n')
      expect((await readTab(phone, worktree, tabId)).content).toBe('# edited on the server\n')
    } finally {
      await host.dispose()
    }
  })
}
