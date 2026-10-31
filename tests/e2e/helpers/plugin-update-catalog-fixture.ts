import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import { pluginManifestSchema } from '../../../src/shared/plugins/manifest/plugin-manifest'
import { pluginContributionSummary } from '../../../src/shared/plugins/contributions/plugin-contribution-summary'
import { pluginCatalogTypes } from '../../../src/shared/plugins/catalog/plugin-catalog-release'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { headCommit, runGit } from './plugin-git-fixture'

export const PLUGINS = ['orca-review-notes', 'orca-review-tasks'] as const

export async function writePlugin(repository: string, id: string, version: string): Promise<void> {
  await mkdir(repository, { recursive: true })
  await writeFile(
    join(repository, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      id,
      publisher: 'stablyai',
      name: id === PLUGINS[0] ? 'Review Notes' : 'Review Tasks',
      version,
      execution: version === '1.0.0' ? 'data' : 'trusted-worker',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      ...(version === '1.0.0' ? {} : { main: 'worker.mjs' }),
      contributes:
        id === PLUGINS[0]
          ? { iconThemes: [{ id: 'review', title: 'Review Icons', path: 'icons.json' }] }
          : { terminalThemes: [{ id: 'review', title: 'Review Terminal', path: 'terminal.json' }] },
      capabilities: []
    })
  )
  await writeFile(
    join(repository, 'icons.json'),
    JSON.stringify({ schemaVersion: 1, icons: { file: 'file.svg' } })
  )
  await writeFile(
    join(repository, 'file.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#888888"/></svg>'
  )
  await writeFile(
    join(repository, 'terminal.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'light',
      terminal: { background: '#eeeeee', foreground: '#181818', red: '#ff0000' }
    })
  )
  if (version !== '1.0.0') {
    await writeFile(join(repository, 'worker.mjs'), 'export function activate() {}\n')
  }
}

export async function publishCatalog(
  repositories: string,
  gitEnvironment: Record<string, string>,
  version: string
): Promise<void> {
  const plugins = await Promise.all(
    PLUGINS.map(async (id) => {
      const repository = join(repositories, `${id}.git`)
      const manifest = pluginManifestSchema.parse(
        JSON.parse(await readFile(join(repository, 'orca-plugin.json'), 'utf8'))
      )
      const tree = await hashPluginTree(repository)
      if (!tree.ok) {
        throw new Error(tree.error)
      }
      return {
        id: `stablyai.${id}`,
        source: { kind: 'git', url: `https://github.com/stablyai/${id}.git`, ref: 'main' },
        categories: ['themes'],
        releases: [
          {
            version,
            name: manifest.name,
            commit: await headCommit(repository, gitEnvironment),
            contentHash: tree.hash,
            execution: manifest.manifestVersion === 2 ? manifest.execution : 'data',
            minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
            types: pluginCatalogTypes(manifest),
            contributes: pluginContributionSummary(manifest),
            capabilities: []
          }
        ]
      }
    })
  )
  await writeFile(
    join(repositories, 'orca-plugins.git', 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'Orca Plugins', owner: 'stablyai', plugins })
  )
}

/** Commits everything in a fixture repository as a new release. */
export async function commitFixtureChange(
  repository: string,
  gitEnvironment: Record<string, string>,
  message: string
): Promise<void> {
  await runGit(repository, ['add', '--all'], gitEnvironment)
  await runGit(
    repository,
    [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      message
    ],
    gitEnvironment
  )
}
