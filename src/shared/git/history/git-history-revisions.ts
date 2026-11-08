import type { GitHistoryExecutor, GitHistoryItemRef, GitHistoryRefs } from './git-history-types'
import { gitHistoryRefFromFullName } from './git-history-log-parser'

export function isGitHistoryRefName(name: string): boolean {
  return (
    /^refs\/(heads|remotes|tags)\/[^\s~^:?*[\\]+$/.test(name) &&
    [...name].every((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
  )
}

export function validateHistoryRefs(refs: GitHistoryRefs): void {
  if (
    Array.isArray(refs) &&
    (refs.length > 1000 || refs.some((name) => !isGitHistoryRefName(name)))
  ) {
    throw new Error('Expected full branch or tag ref names')
  }
}

export async function loadGitHistoryRefs(
  git: GitHistoryExecutor,
  cwd: string,
  query?: string
): Promise<GitHistoryItemRef[]> {
  const { stdout } = await git(
    [
      'for-each-ref',
      '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(refname)%00%(worktreepath)',
      'refs/heads',
      'refs/remotes',
      'refs/tags'
    ],
    cwd
  )
  const search = query?.toLowerCase()
  const rows = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0'))
    .filter((row) => !search || row[5]?.toLowerCase().includes(search))
  const nested = rows.filter((row) => !row[4] && row[3] === 'tag')
  const peeled = new Map<string, string>()
  if (nested.length) {
    const result = await git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      cwd,
      nested.map((row) => `${row[0]}^{commit}\n`).join('')
    )
    result.stdout
      .trimEnd()
      .split('\n')
      .forEach((line, index) => {
        const [oid, type] = line.split(' ')
        const name = nested[index]?.[5]
        if (name && oid && type === 'commit') {
          peeled.set(name, oid)
        }
      })
  }
  const refs: GitHistoryItemRef[] = []
  for (const [oid, type, peeledOid, peeledType, symref, name, worktreePath] of rows) {
    if (!name || symref) {
      continue
    }
    const revision =
      type === 'commit' ? oid : peeledType === 'commit' ? peeledOid : peeled.get(name)
    if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
      continue
    }
    refs.push({
      ...gitHistoryRefFromFullName(name, name, revision),
      ...(worktreePath ? { worktreePath } : {})
    })
  }
  return refs
}
