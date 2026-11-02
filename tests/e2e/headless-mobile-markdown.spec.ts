import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { pairMobileClient } from './helpers/paired-mobile-client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'
import type { RuntimeMarkdownReadTabResult } from '../../src/shared/mobile-markdown-document'

test('a phone creates, edits, and saves a note on a host without a renderer', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    let worktree = ''
    await expect
      .poll(async () => {
        const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
          'worktree.ps',
          {}
        )
        worktree = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
        return worktree
      })
      .not.toBe('')
    worktree = `id:${worktree}`
    await phone.call('files.createFile', {
      worktree,
      relativePath: 'untitled.md',
      expectedExecutionHostId: 'local'
    })
    await phone.call('files.open', { worktree, relativePath: 'untitled.md' })
    const listed = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree
    })
    const tab = listed.tabs.find(
      (candidate) => candidate.type === 'markdown' && candidate.relativePath === 'untitled.md'
    )
    expect(tab).toBeDefined()
    if (!tab) {
      throw new Error('Note tab missing')
    }
    const params = { worktree, tabId: tab.id }
    const initial = await phone.call<RuntimeMarkdownReadTabResult>('markdown.readTab', params)
    expect(initial).toMatchObject({ content: '', editable: true, isDirty: false })
    const content = '# Mobile note\n\nSaved from the phone.'
    await phone.call('markdown.saveTab', { ...params, baseVersion: initial.version, content })
    expect(await readFile(path.join(testRepoPath, 'untitled.md'), 'utf8')).toBe(content)
    await expect(
      phone.call('markdown.saveTab', {
        ...params,
        baseVersion: initial.version,
        content: 'stale phone'
      })
    ).rejects.toThrow('conflict')
    const fresh = await phone.call<RuntimeMarkdownReadTabResult>('markdown.readTab', params)
    await writeFile(path.join(testRepoPath, 'untitled.md'), 'external edit')
    await expect(
      phone.call('markdown.saveTab', {
        ...params,
        baseVersion: fresh.version,
        content: 'lost external edit'
      })
    ).rejects.toThrow('conflict')
    expect(await readFile(path.join(testRepoPath, 'untitled.md'), 'utf8')).toBe('external edit')
    await phone.call('files.createFile', {
      worktree,
      relativePath: 'second.md',
      expectedExecutionHostId: 'local'
    })
    await phone.call('files.open', { worktree, relativePath: 'second.md' })
    const withSecond = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree
    })
    expect(
      withSecond.tabs
        .filter((candidate) => candidate.type === 'markdown')
        .map((candidate) => candidate.relativePath)
    ).toEqual(['untitled.md', 'second.md'])
    await phone.call('session.tabs.close', { worktree, tabId: tab.id, reason: 'user' })
    await expect(phone.call('markdown.readTab', params)).rejects.toThrow('tab_not_found')
  } finally {
    await host.dispose()
  }
})
