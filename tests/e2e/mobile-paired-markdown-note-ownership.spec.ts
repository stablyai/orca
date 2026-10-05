import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, test } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

type NoteProofResult = {
  creatingMarkdown: boolean
  error: string
  hostReads: { ok: boolean; runtimeId?: string }[]
  calls: {
    method: string
    params: unknown
    options?: unknown
    ok: boolean
    runtimeId?: string
  }[]
  bridgedMethods?: string[]
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- WHY: this augments the existing browser Window interface.
  interface Window {
    __pairedNotes: {
      createPairedMarkdownNote: (
        pairingUrl: string,
        worktreeId: string,
        transport: 'native-direct' | 'web-bridge'
      ) => Promise<NoteProofResult>
    }
  }
}

test('creates paired Markdown notes through the native client and web bridge', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'mobile-note-owner')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  writeFileSync(path.join(fixture.worktreePath, 'untitled.md'), 'Existing note stays intact\n')
  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('The isolated worktree did not become active')
  }
  const pairingUrl = await orcaPage.evaluate(async () => {
    const offer = await window.api.mobile.getPairingQR({
      address: '127.0.0.1',
      connectionMode: 'local-only'
    })
    if (!offer.available) {
      throw new Error('The isolated app did not offer local pairing')
    }
    return offer.pairingUrl
  })
  const bundled = await build({
    absWorkingDir: path.resolve('mobile'),
    entryPoints: ['src/test-support/paired-markdown-note-proof.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__pairedNotes',
    target: 'es2022',
    banner: {
      js: "globalThis.process ??= { env: { NODE_ENV: 'development', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };"
    },
    alias: {
      'react-native': 'react-native-web',
      // Why: desktop E2E installs root dependencies; Chromium owns this fixture's secure RNG.
      'expo-crypto': path.resolve('tests/e2e/helpers/paired-note-browser-crypto.ts')
    },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    define: {
      global: 'globalThis',
      __DEV__: 'false',
      'process.env.NODE_ENV': '"development"',
      'process.env.EXPO_OS': '"web"'
    }
  })
  const bundleErrors: string[] = []
  orcaPage.on('pageerror', (error) => bundleErrors.push(error.message))
  await orcaPage.addScriptTag({ content: bundled.outputFiles[0].text })
  expect(bundleErrors).toEqual([])

  for (const [transport, filename, attempts] of [
    ['native-direct', 'untitled-2.md', 2],
    ['web-bridge', 'untitled-3.md', 3]
  ] as const) {
    const result = await orcaPage.evaluate(
      ({ pairingUrl, worktreeId, transport }) =>
        window.__pairedNotes.createPairedMarkdownNote(pairingUrl, worktreeId, transport),
      { pairingUrl, worktreeId, transport }
    )
    expect(result.error).toBe('')
    expect(result.creatingMarkdown).toBe(false)
    const admitted = [...result.hostReads, ...result.calls].filter((call) => call.ok)
    expect(result.hostReads.every((call) => call.ok)).toBe(true)
    expect(
      admitted.every((call) => typeof call.runtimeId === 'string' && call.runtimeId.length > 0)
    ).toBe(true)
    expect(new Set(admitted.map((call) => call.runtimeId)).size).toBe(1)
    if (transport === 'web-bridge') {
      const creates = result.calls.filter((call) => call.method === 'files.createFile')
      expect(creates).toHaveLength(attempts)
      expect(creates.at(-1)).toMatchObject({
        ok: true,
        params: { expectedExecutionHostId: 'local', relativePath: filename },
        options: { timeoutMs: 15_000 }
      })
      expect(result.bridgedMethods).toContain('files.createFile')
      expect(result.bridgedMethods).toContain('files.open')
    }
    expect(readFileSync(path.join(fixture.worktreePath, filename), 'utf8')).toBe('')
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText(filename)
    await expect(orcaPage.locator('.tiptap.ProseMirror')).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath(`${transport}-paired-note.png`) })
  }
  expect(readFileSync(path.join(fixture.worktreePath, 'untitled.md'), 'utf8')).toBe(
    'Existing note stays intact\n'
  )
})
