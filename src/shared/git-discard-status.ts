export type GitDiscardPathKind = 'intent-to-add' | 'tracked' | 'untracked'

type StatusRecord = {
  path: string
  xy: string
}

function parseStatusRecords(stdout: string): StatusRecord[] {
  const fields = stdout.split('\0')
  const records: StatusRecord[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4) {
      continue
    }
    const xy = field.slice(0, 2)
    records.push({ path: field.slice(3), xy })
    if (xy.includes('R') || xy.includes('C')) {
      index += 1
    }
  }
  return records
}

function trimTrailingPathSeparators(filePath: string): string {
  return filePath.replace(/\/+$/, '')
}

function recordMatchesSelection(recordPath: string, selectedPath: string): boolean {
  const record = trimTrailingPathSeparators(recordPath)
  const selected = trimTrailingPathSeparators(selectedPath)
  return record === selected || record.startsWith(`${selected}/`)
}

export function classifyGitDiscardPaths(
  statusOutput: string,
  selectedPaths: readonly string[],
  selectedPathForStatus: (filePath: string) => string = (filePath) => filePath
): Map<string, GitDiscardPathKind> {
  const records = parseStatusRecords(statusOutput)
  return new Map(
    selectedPaths.map((selectedPath) => {
      let kind: GitDiscardPathKind = 'untracked'
      const statusPath = selectedPathForStatus(selectedPath)
      for (const record of records) {
        if (!recordMatchesSelection(record.path, statusPath)) {
          continue
        }
        if (record.xy === ' A') {
          if (kind === 'untracked') {
            kind = 'intent-to-add'
          }
        } else if (record.xy !== '??' && record.xy !== '!!') {
          kind = 'tracked'
          break
        }
      }
      return [selectedPath, kind]
    })
  )
}

export function gitDiscardStatusArgs(
  selectedPaths: readonly string[],
  literalPathspec: (filePath: string) => string
): string[] {
  return [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored',
    '--no-renames',
    '--',
    ...selectedPaths.map(literalPathspec)
  ]
}
