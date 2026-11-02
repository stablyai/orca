/**
 * Official ids start with `orca-`, as the catalog requires for unsolicited suggestions.
 *
 * Invariant: opening a file a catalog plugin handles suggests that plugin — an unknown file
 * (.gleam syntax), Orca's binary placeholder (.xlsx editor), and a file Orca already shows as text
 * (.excalidraw editor). View plugin opens the plugin's page and never installs.
 */

import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { hashPluginTree } from '../../src/main/plugins/plugin-content-hash'
import { pluginContributionSummary } from '../../src/shared/plugins/contributions/plugin-contribution-summary'
import { pluginEditorFileTypes } from '../../src/shared/plugins/contributions/plugin-file-type'
import { parsePluginManifest } from '../../src/shared/plugins/manifest/plugin-manifest'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { commitRepository, configureFixtureGit, headCommit } from './helpers/plugin-git-fixture'
import { openRepoFile } from './helpers/plugin-smoke'

const SYNTAX_PLUGIN = 'orca-gleam-syntax'
const SYNTAX_PLUGIN_KEY = `stablyai.${SYNTAX_PLUGIN}`

const EDITORS = [
  {
    repo: 'orca-spreadsheet',
    name: 'Spreadsheet Viewer',
    editor: {
      id: 'spreadsheet',
      title: 'Spreadsheet',
      extensions: ['.xlsx'],
      entry: 'editor/index.html',
      contentKind: 'bytes'
    }
  },
  {
    repo: 'orca-excalidraw',
    name: 'Excalidraw',
    editor: {
      id: 'excalidraw',
      title: 'Excalidraw',
      extensions: ['.excalidraw', '.excalidraw.json'],
      entry: 'editor/index.html'
    }
  }
] as const

async function createCatalogFixture(root: string) {
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, [
    'orca-plugins',
    SYNTAX_PLUGIN,
    ...EDITORS.map((plugin) => plugin.repo)
  ])

  const syntaxDir = join(repositories, `${SYNTAX_PLUGIN}.git`)
  await cp(join(process.cwd(), 'examples', 'plugins', SYNTAX_PLUGIN), syntaxDir, {
    recursive: true
  })
  // Why before init: the release vouches for the plugin files, not the repository metadata.
  const syntaxHash = await hashPluginTree(syntaxDir)
  if (!syntaxHash.ok) {
    throw new Error(syntaxHash.error)
  }
  await commitRepository(syntaxDir, gitEnvironment)
  const plugins: unknown[] = [
    {
      id: SYNTAX_PLUGIN_KEY,
      source: {
        kind: 'git',
        url: `https://github.com/stablyai/${SYNTAX_PLUGIN}.git`,
        ref: 'v1.0.0'
      },
      releases: [
        {
          version: '1.0.0',
          commit: await headCommit(syntaxDir, gitEnvironment),
          contentHash: syntaxHash.hash,
          execution: 'data',
          minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
          name: 'Gleam',
          types: ['syntax'],
          fileTypes: ['gleam']
        }
      ]
    }
  ]

  for (const plugin of EDITORS) {
    const dir = join(repositories, `${plugin.repo}.git`)
    await mkdir(join(dir, 'editor'), { recursive: true })
    await writeFile(join(dir, 'editor', 'index.html'), '<main>editor</main>\n')
    const manifest = {
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: plugin.repo,
      publisher: 'stablyai',
      name: plugin.name,
      version: '1.0.0',
      license: 'MIT',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: { customEditors: [plugin.editor] }
    }
    await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(manifest))
    const parsed = parsePluginManifest(manifest)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    const hashed = await hashPluginTree(dir)
    if (!hashed.ok) {
      throw new Error(hashed.error)
    }
    await commitRepository(dir, gitEnvironment)
    plugins.push({
      id: `stablyai.${plugin.repo}`,
      source: { kind: 'git', url: `https://github.com/stablyai/${plugin.repo}.git`, ref: 'v1.0.0' },
      releases: [
        {
          version: '1.0.0',
          commit: await headCommit(dir, gitEnvironment),
          contentHash: hashed.hash,
          execution: 'sandboxed-ui',
          minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
          name: plugin.name,
          contributes: pluginContributionSummary(parsed.manifest),
          fileTypes: pluginEditorFileTypes(parsed.manifest.contributes),
          editorFileTypes: pluginEditorFileTypes(parsed.manifest.contributes)
        }
      ]
    })
  }

  const catalog = join(repositories, 'orca-plugins.git')
  await mkdir(catalog, { recursive: true })
  await writeFile(
    join(catalog, 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'Orca Plugins', owner: 'stablyai', plugins })
  )
  await commitRepository(catalog, gitEnvironment)

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'main.gleam'), 'pub fn main() { Nil }\n')
  // NULs make Orca show its binary placeholder, as it does for a real workbook.
  await writeFile(join(workspace, 'book.xlsx'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))
  await writeFile(join(workspace, 'scene.excalidraw'), '{"type":"excalidraw","elements":[]}\n')
  await commitRepository(workspace, gitEnvironment)
  // Why realpath: Orca registers the repository by its resolved path, as macOS /var is a link.
  return { gitEnvironment, workspace: await realpath(workspace) }
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('suggests catalog plugins for file types and never installs them', async ({}, testInfo) => {
  // Why: one Electron launch plus a Git catalog fetch and a plugin page; slower than the 30s default on CI.
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-file-type-suggestion-e2e-'))
  const fixture = await createCatalogFixture(root)
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const page = launched.page
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      await window.api.plugins.refreshMarketplaces?.({})
    })
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.plugins.listMarketplacePlugins()).map((entry) => entry.pluginKey)
          ),
        { timeout: 60_000 }
      )
      .toEqual(
        expect.arrayContaining([
          SYNTAX_PLUGIN_KEY,
          'stablyai.orca-spreadsheet',
          'stablyai.orca-excalidraw'
        ])
      )

    await attachRepoAndOpenTerminal(page, fixture.workspace)
    await openRepoFile(page, fixture.workspace, 'main.gleam')
    const banner = page.getByText('A plugin can open .gleam files: Gleam')
    await expect(banner).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'View plugin' }).click()
    // Why the page: a suggestion leads to the same one-action install as the catalog, no dialog.
    const pluginPage = page.getByRole('article')
    await expect(pluginPage.locator('#plugin-detail-heading')).toContainText('Gleam', {
      timeout: 30_000
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(
      await page.evaluate(async () =>
        (await window.api.plugins.list()).map((entry) => entry.pluginKey)
      )
    ).not.toContain(SYNTAX_PLUGIN_KEY)

    await page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await page.getByRole('button', { name: "Don't suggest for .gleam" }).click()
    await expect(banner).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => window.__store?.getState().settings?.pluginDismissedFileTypes)
      )
      .toEqual(['gleam'])

    await openRepoFile(page, fixture.workspace, 'book.xlsx')
    await expect(page.getByText('A plugin can open .xlsx files: Spreadsheet Viewer')).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByText('Binary file — cannot display')).toBeVisible()

    await openRepoFile(page, fixture.workspace, 'scene.excalidraw')
    const editorBanner = page.getByText('A plugin adds an editor for .excalidraw files: Excalidraw')
    await expect(editorBanner).toBeVisible({ timeout: 15_000 })
    // The file still opens as highlighted JSON underneath.
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('excalidraw')
    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(editorBanner).toBeHidden()
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
