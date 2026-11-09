// Environment variable NAMES a repo's existing tool configs expect, to seed an org environment's
// secret list. Values are never read out: a name is the only thing that leaves this module.
import type { SetupScriptImportFileRead } from './setup-script-imports'
import { asRecord, parseJsoncObject, parseTomlObject } from './setup-script-import-parsers'

export type SetupEnvVarNameImport = {
  names: string[]
  /** Repo-relative files that contributed at least one name. */
  files: string[]
}

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const MAX_NAMES = 100
const CONDUCTOR_FILES = ['.conductor/settings.toml', '.conductor/settings.local.toml'] as const
const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'] as const
const DOTENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template'] as const
const DEVCONTAINER_ENV_FIELDS = ['secrets', 'containerEnv', 'remoteEnv'] as const
const LOCAL_ENV_REFERENCE = /\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

// Set by the shell or the VM itself; asking an admin for a secret with these names would be wrong.
const SYSTEM_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'HOSTNAME',
  'TMPDIR',
  'NODE_ENV',
  'CI'
])

export async function inspectSetupEnvVarNames(
  readFile: SetupScriptImportFileRead
): Promise<SetupEnvVarNameImport> {
  const names = new Set<string>()
  const files: string[] = []
  const collect = (file: string, found: Iterable<string>): void => {
    let added = false
    for (const raw of found) {
      const name = raw.trim()
      if (names.size >= MAX_NAMES) {
        break
      }
      if (ENV_VAR_NAME.test(name) && !SYSTEM_NAMES.has(name) && !name.startsWith('ORCA_')) {
        if (!names.has(name)) {
          names.add(name)
          added = true
        }
      }
    }
    if (added) {
      files.push(file)
    }
  }

  for (const file of CONDUCTOR_FILES) {
    const settings = parseTomlObject(await readFile(file))
    const env = asRecord(settings?.environment_variables)
    if (env) {
      collect(file, Object.keys(env))
    }
  }

  for (const file of DEVCONTAINER_FILES) {
    const content = await readFile(file)
    const config = parseJsoncObject(content)
    if (!content || !config) {
      continue
    }
    const found: string[] = []
    for (const field of DEVCONTAINER_ENV_FIELDS) {
      const record = asRecord(config[field])
      if (record) {
        found.push(...Object.keys(record))
      }
    }
    for (const match of content.matchAll(LOCAL_ENV_REFERENCE)) {
      found.push(match[1])
    }
    collect(file, found)
    // The spec reads the first config that exists, like the setup-script importer.
    break
  }

  for (const file of DOTENV_EXAMPLE_FILES) {
    const content = await readFile(file)
    if (!content) {
      continue
    }
    const found: string[] = []
    for (const line of content.split(/\r?\n/)) {
      const match = DOTENV_LINE.exec(line)
      if (match) {
        found.push(match[1])
      }
    }
    collect(file, found)
  }

  return { names: [...names], files }
}
