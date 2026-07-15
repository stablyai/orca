import { decodeGitCQuotedPath } from '../../../../shared/git-cquoted-path'

export type NativeChatReportedFileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export type NativeChatReportedFileChangeCandidate = {
  path: string
  status: NativeChatReportedFileChangeStatus
  previousPath?: string
  binary?: boolean
}

type GitDiffSection = {
  oldPath: string | null
  newPath: string | null
  status: NativeChatReportedFileChangeStatus
  binary: boolean
}

/** Parse paths that an editing tool reports through apply-patch or unified-diff text. */
export function parseNativeChatReportedFileChangeCandidates(
  value: string,
  maxChanges: number
): NativeChatReportedFileChangeCandidate[] {
  if (!value || maxChanges <= 0) {
    return []
  }

  const changes: NativeChatReportedFileChangeCandidate[] = []
  const lines = value.split(/\r?\n/)
  let currentPatchUpdate: NativeChatReportedFileChangeCandidate | null = null
  let gitSection: GitDiffSection | null = null
  let oldHeaderPath: string | null | undefined

  const push = (change: NativeChatReportedFileChangeCandidate): void => {
    if (changes.length < maxChanges) {
      changes.push(change)
    }
  }

  const finishGitSection = (): void => {
    if (!gitSection) {
      return
    }
    const path = gitSection.status === 'deleted' ? gitSection.oldPath : gitSection.newPath
    if (path) {
      push({
        path,
        status: gitSection.status,
        ...(gitSection.status === 'renamed' && gitSection.oldPath
          ? { previousPath: gitSection.oldPath }
          : {}),
        binary: gitSection.binary
      })
    }
    gitSection = null
  }

  for (const line of lines) {
    if (changes.length >= maxChanges) {
      break
    }

    const patchMarker = parseApplyPatchMarker(line)
    if (patchMarker) {
      if (patchMarker.kind === 'move') {
        if (currentPatchUpdate) {
          currentPatchUpdate.previousPath = currentPatchUpdate.path
          currentPatchUpdate.path = patchMarker.path
          currentPatchUpdate.status = 'renamed'
        }
      } else {
        const candidate: NativeChatReportedFileChangeCandidate = {
          path: patchMarker.path,
          status: patchMarker.kind
        }
        push(candidate)
        currentPatchUpdate = patchMarker.kind === 'modified' ? candidate : null
      }
      continue
    }

    if (line.startsWith('diff --git ')) {
      finishGitSection()
      const paths = parseDiffGitPaths(line.slice('diff --git '.length))
      gitSection = paths
        ? { oldPath: paths[0], newPath: paths[1], status: 'modified', binary: false }
        : null
      oldHeaderPath = undefined
      continue
    }

    if (gitSection) {
      updateGitSection(gitSection, line)
      continue
    }

    if (line.startsWith('--- ')) {
      oldHeaderPath = normalizeDiffPath(readHeaderPath(line.slice(4)))
      continue
    }
    if (line.startsWith('+++ ') && oldHeaderPath !== undefined) {
      const newPath = normalizeDiffPath(readHeaderPath(line.slice(4)))
      if (oldHeaderPath === null && newPath) {
        push({ path: newPath, status: 'added' })
      } else if (oldHeaderPath && newPath === null) {
        push({ path: oldHeaderPath, status: 'deleted' })
      } else if (newPath) {
        push({ path: newPath, status: 'modified' })
      }
      oldHeaderPath = undefined
      continue
    }

    const binaryPaths = parseBinaryPaths(line)
    if (binaryPaths) {
      const binaryPath = binaryPaths[1] ?? binaryPaths[0]
      if (binaryPath) {
        push({ path: binaryPath, status: 'modified', binary: true })
      }
    }
  }

  finishGitSection()
  return changes
}

export function normalizeNativeChatReportedFilePath(value: string): string {
  const path = readWholePath(value).replace(/\\/g, '/')
  return path.startsWith('./') ? path.slice(2) : path
}

function updateGitSection(section: GitDiffSection, line: string): void {
  if (line.startsWith('new file mode ')) {
    section.status = 'added'
  } else if (line.startsWith('deleted file mode ')) {
    section.status = 'deleted'
  } else if (line.startsWith('rename from ')) {
    section.oldPath = normalizeDiffPath(readWholePath(line.slice('rename from '.length)))
    section.status = 'renamed'
  } else if (line.startsWith('rename to ')) {
    section.newPath = normalizeDiffPath(readWholePath(line.slice('rename to '.length)))
    section.status = 'renamed'
  } else if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
    section.binary = true
  }
}

function parseApplyPatchMarker(
  line: string
): { kind: NativeChatReportedFileChangeStatus | 'move'; path: string } | null {
  const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
  if (match) {
    const status = { Add: 'added', Update: 'modified', Delete: 'deleted' } as const
    return { kind: status[match[1] as keyof typeof status], path: readWholePath(match[2]) }
  }
  const move = /^\*\*\* Move to: (.+)$/.exec(line)
  return move ? { kind: 'move', path: readWholePath(move[1]) } : null
}

function parseDiffGitPaths(value: string): [string | null, string | null] | null {
  const first = readToken(value)
  if (!first) {
    return null
  }
  const second = readToken(value.slice(first.consumed).trimStart())
  return second ? [normalizeDiffPath(first.value), normalizeDiffPath(second.value)] : null
}

function parseBinaryPaths(value: string): [string | null, string | null] | null {
  if (!value.startsWith('Binary files ') || !value.endsWith(' differ')) {
    return null
  }
  const body = value.slice('Binary files '.length, -' differ'.length)
  const first = readToken(body)
  if (!first) {
    return null
  }
  const remainder = body.slice(first.consumed).trimStart()
  if (!remainder.startsWith('and ')) {
    return null
  }
  const second = readToken(remainder.slice(4))
  return second ? [normalizeDiffPath(first.value), normalizeDiffPath(second.value)] : null
}

function normalizeDiffPath(value: string): string | null {
  const path = normalizeNativeChatReportedFilePath(value)
  if (!path || path === '/dev/null') {
    return null
  }
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

function readHeaderPath(value: string): string {
  return readToken(value)?.value ?? ''
}

function readWholePath(value: string): string {
  const trimmed = value.trim().split('\t', 1)[0] ?? ''
  const token = readToken(trimmed)
  return token && token.consumed === trimmed.length ? token.value : trimmed
}

function readToken(value: string): { value: string; consumed: number } | null {
  if (!value) {
    return null
  }
  if (value[0] !== '"') {
    const end = value.search(/\s/)
    return {
      value: end === -1 ? value : value.slice(0, end),
      consumed: end === -1 ? value.length : end
    }
  }

  let escaped = false
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]
    if (char === '"' && !escaped) {
      const token = value.slice(0, index + 1)
      return { value: decodeGitCQuotedPath(token), consumed: index + 1 }
    }
    escaped = char === '\\' && !escaped
    if (char !== '\\') {
      escaped = false
    }
  }
  return null
}
