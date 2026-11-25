// Shared so Orca's CLI finds a chat's published files where its host wrote them.
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * The profile folder Hermes runs from `home`. Hermes trusts a `HERMES_HOME` inside `profiles/`;
 * for its root it follows the sticky `active_profile`, which `hermes profile use` changes.
 */
export async function resolveHermesActiveProfileHome(home: string): Promise<string> {
  if (basename(dirname(home)) === 'profiles') {
    return home
  }
  const name = await readFile(join(home, 'active_profile'), 'utf-8').then(
    (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim(),
    () => ''
  )
  if (!name || name === 'default' || !/^[\w.-]+$/u.test(name)) {
    return home
  }
  const profile = join(home, 'profiles', name)
  const exists = await stat(profile).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  return exists ? profile : home
}
