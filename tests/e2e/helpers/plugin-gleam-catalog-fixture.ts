import { cp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { commitRepository, configureFixtureGit, headCommit } from './plugin-git-fixture'

const PLUGIN = 'orca-gleam-syntax'
export const GLEAM_PLUGIN_KEY = `stablyai.${PLUGIN}`

/** An official catalog listing the Gleam syntax plugin, plus a workspace with a .gleam file. */
export async function createGleamCatalogFixture(root: string) {
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, ['orca-plugins', PLUGIN])

  const plugin = join(repositories, `${PLUGIN}.git`)
  await cp(join(process.cwd(), 'examples', 'plugins', PLUGIN), plugin, { recursive: true })
  // Why before init: the release vouches for the plugin files, not the repository metadata.
  const hashed = await hashPluginTree(plugin)
  if (!hashed.ok) {
    throw new Error(hashed.error)
  }
  await commitRepository(plugin, gitEnvironment)

  const catalog = join(repositories, 'orca-plugins.git')
  await mkdir(catalog, { recursive: true })
  await writeFile(
    join(catalog, 'orca-catalog.json'),
    JSON.stringify({
      catalogVersion: 2,
      name: 'Orca Plugins',
      owner: 'stablyai',
      plugins: [
        {
          id: GLEAM_PLUGIN_KEY,
          source: { kind: 'git', url: `https://github.com/stablyai/${PLUGIN}.git`, ref: 'v1.0.0' },
          releases: [
            {
              version: '1.0.0',
              commit: await headCommit(plugin, gitEnvironment),
              contentHash: hashed.hash,
              execution: 'data',
              minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
              name: 'Gleam',
              types: ['syntax'],
              fileTypes: ['gleam']
            }
          ]
        }
      ]
    })
  )
  await commitRepository(catalog, gitEnvironment)

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'main.gleam'), 'pub fn main() { Nil }\n')
  await commitRepository(workspace, gitEnvironment)
  // Why realpath: Orca registers the repository by its resolved path, as macOS /var is a link.
  return { gitEnvironment, workspace: await realpath(workspace) }
}
