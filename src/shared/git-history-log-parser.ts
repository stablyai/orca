import type { GitHistoryItem, GitHistoryItemRef } from './git-history-types'

export const GIT_HISTORY_COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B'

export function shortGitHash(hash: string): string {
  return hash.slice(0, 7)
}

function commitSubject(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim()
  return firstLine || '(no commit message)'
}

function parseGitDecorationRefs(raw: string, revision: string): GitHistoryItemRef[] {
  if (!raw.trim()) {
    return []
  }

  const refs: GitHistoryItemRef[] = []
  for (const part of raw.split(',')) {
    const ref = part.trim()
    if (!ref || ref === 'HEAD' || /^refs\/remotes\/[^/]+\/HEAD(?:\s|$)/.test(ref)) {
      continue
    }

    if (ref.startsWith('HEAD -> refs/heads/')) {
      refs.push({
        id: ref.slice('HEAD -> '.length),
        name: ref.slice('HEAD -> refs/heads/'.length),
        revision,
        category: 'branches'
      })
      continue
    }

    if (ref.startsWith('refs/heads/')) {
      refs.push({
        id: ref,
        name: ref.slice('refs/heads/'.length),
        revision,
        category: 'branches'
      })
      continue
    }

    if (ref.startsWith('refs/remotes/')) {
      refs.push({
        id: ref,
        name: ref.slice('refs/remotes/'.length),
        revision,
        category: 'remote branches'
      })
      continue
    }

    if (ref.startsWith('tag: refs/tags/')) {
      refs.push({
        id: ref.slice('tag: '.length),
        name: ref.slice('tag: refs/tags/'.length),
        revision,
        category: 'tags'
      })
    }
  }

  return refs.sort(compareGitHistoryItemRefsByCategory)
}

export function compareGitHistoryItemRefsByCategory(
  ref1: GitHistoryItemRef,
  ref2: GitHistoryItemRef
): number {
  const order = (ref: GitHistoryItemRef): number => {
    if (ref.id.startsWith('refs/heads/')) {
      return 1
    }
    if (ref.id.startsWith('refs/remotes/')) {
      return 2
    }
    if (ref.id.startsWith('refs/tags/')) {
      return 3
    }
    return 99
  }

  const categoryOrder = order(ref1) - order(ref2)
  return categoryOrder || ref1.name.localeCompare(ref2.name)
}

export function parseGitHistoryLog(stdout: string): GitHistoryItem[] {
  const items: GitHistoryItem[] = []
  for (const rawRecord of stdout.split('\0')) {
    const record = rawRecord.replace(/^\n+/, '')
    if (!record.trim()) {
      continue
    }

    const lines = record.split('\n')
    const hash = lines[0]?.trim() ?? ''
    if (!/^[0-9a-fA-F]{40,64}$/.test(hash)) {
      continue
    }

    const authorName = lines[1] ?? ''
    const authorEmail = lines[2] ?? ''
    const authorDateSeconds = Number.parseInt(lines[3] ?? '', 10)
    const parents = (lines[5] ?? '').trim()
    const decorations = lines[6] ?? ''
    const message = lines.slice(7).join('\n').replace(/\n$/, '')

    items.push({
      id: hash,
      parentIds: parents ? parents.split(' ') : [],
      subject: commitSubject(message),
      message,
      author: authorName || undefined,
      authorEmail: authorEmail || undefined,
      displayId: shortGitHash(hash),
      timestamp: Number.isFinite(authorDateSeconds) ? authorDateSeconds * 1000 : undefined,
      references: parseGitDecorationRefs(decorations, hash)
    })
  }
  return items
}

export function gitHistoryRefFromFullName(
  fullName: string | null,
  fallbackName: string,
  revision: string
): GitHistoryItemRef {
  const id = fullName || fallbackName
  if (id.startsWith('refs/heads/')) {
    return { id, name: id.slice('refs/heads/'.length), revision, category: 'branches' }
  }
  if (id.startsWith('refs/remotes/')) {
    return { id, name: id.slice('refs/remotes/'.length), revision, category: 'remote branches' }
  }
  if (id.startsWith('refs/tags/')) {
    return { id, name: id.slice('refs/tags/'.length), revision, category: 'tags' }
  }
  return { id, name: fallbackName || shortGitHash(revision), revision, category: 'commits' }
}
