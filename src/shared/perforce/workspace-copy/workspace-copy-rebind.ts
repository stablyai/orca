import { chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import { pathExists, type CopySource } from './workspace-copy-source'
import { escapeRegex } from '../../string-utils'

const NO_SEARCH = new Set(['library', 'temp', 'logs', 'obj', 'node_modules', '.git', 'assets'])

/** Rewrites a text file in place, keeping its BOM (or lack of one); true when it changed. */
async function updateTextFile(path: string, transform: (text: string) => string): Promise<boolean> {
  const bytes = await readFile(path)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const text = bytes.subarray(hasBom ? 3 : 0).toString('utf8')
  const next = transform(text)
  if (next === text) {
    return false
  }
  // Perforce leaves unopened files read-only.
  await chmod(path, 0o666)
  const body = Buffer.from(next, 'utf8')
  await writeFile(path, hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body)
  return true
}

export function setConfigClient(text: string, from: string, to: string): string {
  return text.replace(
    /^([ \t]*P4CLIENT[ \t]*=[ \t]*)(\S+)([ \t\r]*)$/gim,
    (whole, head: string, client: string, tail: string) =>
      client.toLowerCase() === from.toLowerCase() ? `${head}${to}${tail}` : whole
  )
}

/** Rider stores the client and the absolute root in .idea/workspace.xml. */
export function setIdeBindings(
  text: string,
  from: { client: string; root: string },
  to: { client: string; root: string }
): string {
  let out = text
  const pairs = [
    [from.root, to.root],
    [from.root.replaceAll('\\', '/'), to.root.replaceAll('\\', '/')]
  ]
  // Roots first: a client named like the root folder would otherwise be rewritten inside the path.
  for (const [fromRoot, toRoot] of pairs) {
    out = out.replace(
      new RegExp(`${escapeRegex(fromRoot)}(?=[\\\\/"'<>\\s;]|$)`, 'gi'),
      () => toRoot
    )
  }
  return out.replace(
    new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegex(from.client)}(?![A-Za-z0-9_.-])`, 'gi'),
    () => to.client
  )
}

/**
 * Drops Unity's `vcPerforceWorkspace` entry (its key line and the deeper-indented lines under it).
 * The value is obfuscated; it is never decoded or rewritten.
 */
export function removeUnityWorkspaceEntry(text: string): string {
  const lines = text.split(/(?<=\n)/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const key = /^([ \t]*)vcPerforceWorkspace:[ \t\r\n]*$/.exec(lines[i])
    if (!key) {
      out.push(lines[i])
      continue
    }
    const indent = key[1].length
    while (i + 1 < lines.length) {
      const child = /^([ \t]*)\S/.exec(lines[i + 1])
      if (!child || child[1].length <= indent) {
        break
      }
      i += 1
    }
  }
  return out.join('')
}

async function findFiles(
  root: string,
  maxDepth: number,
  matches: (name: string, dir: string) => boolean
): Promise<string[]> {
  const found: string[] = []
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const dir of level) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name)
        if (entry.isFile() && matches(entry.name, dir)) {
          found.push(full)
        } else if (entry.isDirectory() && !NO_SEARCH.has(entry.name.toLowerCase())) {
          next.push(full)
        }
      }
    }
    level = next
  }
  return found
}

/** Points the copy's p4config files, Rider workspace and Unity settings at the copy's own client. */
export async function rebindCopy(
  source: CopySource,
  names: WorkspaceCopyNames,
  unityProjects: readonly string[]
): Promise<string[]> {
  const changed: string[] = []
  const rel = (path: string): string => relative(names.copyRoot, path).replaceAll('\\', '/')
  const configNames = new Set(['p4config.txt', '.p4config', source.configName.toLowerCase()])
  for (const file of await findFiles(names.copyRoot, 2, (name) =>
    configNames.has(name.toLowerCase())
  )) {
    if (await updateTextFile(file, (t) => setConfigClient(t, source.client, names.client))) {
      changed.push(rel(file))
    }
  }
  const from = { client: source.client, root: source.root }
  const to = { client: names.client, root: names.copyRoot }
  const ideaFiles = await findFiles(
    names.copyRoot,
    4,
    (name, dir) => name === 'workspace.xml' && /[\\/]\.idea([\\/]|$)/.test(dir)
  )
  for (const file of ideaFiles) {
    if (await updateTextFile(file, (t) => setIdeBindings(t, from, to))) {
      changed.push(rel(file))
    }
  }
  for (const project of unityProjects) {
    const settings = join(
      names.copyRoot,
      relative(source.root, project),
      'UserSettings',
      'EditorUserSettings.asset'
    )
    if (
      (await pathExists(settings)) &&
      (await updateTextFile(settings, removeUnityWorkspaceEntry))
    ) {
      changed.push(rel(settings))
    }
  }
  return changed
}

/** Unity's Perforce integration ignores p4config, so the copy's editor needs this once to go online. */
export async function unityVersionControlBinding(
  unityProjects: readonly string[],
  client: string
): Promise<string | null> {
  for (const project of unityProjects) {
    const settings = join(project, 'ProjectSettings', 'VersionControlSettings.asset')
    const text = await readFile(settings, 'utf8').catch(() => '')
    if (/^\s*m_Mode:\s*Perforce\s*$/m.test(text)) {
      return `UnityEditor.EditorUserSettings.SetConfigValue("vcPerforceWorkspace", "${client}"); UnityEditor.VersionControl.Provider.UpdateSettings();`
    }
  }
  return null
}
