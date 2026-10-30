import { cp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import { pluginContributionSummary } from '../../../src/shared/plugins/contributions/plugin-contribution-summary'
import { pluginEditorFileTypes } from '../../../src/shared/plugins/contributions/plugin-file-type'
import { parsePluginManifest } from '../../../src/shared/plugins/manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { commitRepository, configureFixtureGit, headCommit } from './plugin-git-fixture'

const PLUGIN = 'orca-gleam-syntax'
export const GLEAM_PLUGIN_KEY = `stablyai.${PLUGIN}`
const EDITOR = 'orca-excalidraw'
export const EXCALIDRAW_PLUGIN_KEY = `stablyai.${EDITOR}`
export const EXCALIDRAW_TEMPLATE = '{"type":"excalidraw","elements":[]}\n'

/** A custom editor with a new-file template, as the official Excalidraw plugin ships. */
async function createEditorPlugin(dir: string) {
  await mkdir(join(dir, 'editor'), { recursive: true })
  await mkdir(join(dir, 'templates'), { recursive: true })
  await writeFile(join(dir, 'editor', 'index.html'), '<main>drawing</main>\n')
  await writeFile(join(dir, 'templates', 'empty.excalidraw'), EXCALIDRAW_TEMPLATE)
  const manifest = {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: EDITOR,
    publisher: 'stablyai',
    name: 'Excalidraw',
    version: '1.0.0',
    license: 'MIT',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    contributes: {
      customEditors: [
        {
          id: 'excalidraw',
          title: 'Excalidraw',
          extensions: ['.excalidraw'],
          entry: 'editor/index.html'
        }
      ],
      newFiles: [
        {
          id: 'drawing',
          title: 'New drawing',
          extension: '.excalidraw',
          template: 'templates/empty.excalidraw'
        }
      ]
    }
  }
  await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(manifest))
  const parsed = parsePluginManifest(manifest)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.manifest
}

/** An official catalog listing the Gleam syntax plugin and an Excalidraw-like editor, plus a
 *  workspace with a .gleam file. */
export async function createGleamCatalogFixture(root: string) {
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, [
    'orca-plugins',
    PLUGIN,
    EDITOR
  ])

  const plugin = join(repositories, `${PLUGIN}.git`)
  await cp(join(process.cwd(), 'examples', 'plugins', PLUGIN), plugin, { recursive: true })
  // Why before init: the release vouches for the plugin files, not the repository metadata.
  const hashed = await hashPluginTree(plugin)
  if (!hashed.ok) {
    throw new Error(hashed.error)
  }
  await commitRepository(plugin, gitEnvironment)

  const editor = join(repositories, `${EDITOR}.git`)
  const editorManifest = await createEditorPlugin(editor)
  const editorHash = await hashPluginTree(editor)
  if (!editorHash.ok) {
    throw new Error(editorHash.error)
  }
  await commitRepository(editor, gitEnvironment)

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
        },
        {
          id: EXCALIDRAW_PLUGIN_KEY,
          source: { kind: 'git', url: `https://github.com/stablyai/${EDITOR}.git`, ref: 'v1.0.0' },
          releases: [
            {
              version: '1.0.0',
              commit: await headCommit(editor, gitEnvironment),
              contentHash: editorHash.hash,
              execution: 'sandboxed-ui',
              minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
              name: 'Excalidraw',
              contributes: pluginContributionSummary(editorManifest),
              fileTypes: pluginEditorFileTypes(editorManifest.contributes),
              editorFileTypes: pluginEditorFileTypes(editorManifest.contributes)
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
