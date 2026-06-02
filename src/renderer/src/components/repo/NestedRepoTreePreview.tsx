import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import { FolderTree, GitBranch } from 'lucide-react'
import type { NestedRepoCandidate, NestedRepoScanResult } from '../../../../shared/types'
import { cn } from '@/lib/utils'

type TreeFolder = {
  key: string
  name: string
  folders: Map<string, TreeFolder>
  repos: NestedRepoCandidate[]
}

type TreeRow =
  | { type: 'folder'; key: string; name: string; depth: number; repoCount: number }
  | { type: 'repo'; repo: NestedRepoCandidate; pathLabel: string; depth: number }

function splitPathSegments(path: string): string[] {
  return path
    .replace(/[\\/]+$/g, '')
    .split(/[\\/]/)
    .filter(Boolean)
}

function relativePathSegments(childPath: string, parentPath: string): string[] {
  const child = splitPathSegments(childPath)
  const parent = splitPathSegments(parentPath)
  let i = 0
  while (i < parent.length && i < child.length && child[i] === parent[i]) {
    i++
  }
  return child.slice(i)
}

function countFolderRepos(folder: TreeFolder): number {
  let count = folder.repos.length
  for (const child of folder.folders.values()) {
    count += countFolderRepos(child)
  }
  return count
}

function repoCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'repo' : 'repos'}`
}

function pathSeparatorForDisplay(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

function pathLabelForRepo(repo: NestedRepoCandidate, parentPath: string): string {
  return relativePathSegments(repo.path, parentPath).join(pathSeparatorForDisplay(repo.path))
}

function appendRepoRow(
  rows: TreeRow[],
  repo: NestedRepoCandidate,
  depth: number,
  parentPath: string
): void {
  rows.push({
    type: 'repo',
    repo,
    pathLabel: pathLabelForRepo(repo, parentPath),
    depth
  })
}

function buildRows(scan: NestedRepoScanResult): TreeRow[] {
  const root: TreeFolder = { key: '', name: '', folders: new Map(), repos: [] }

  for (const repo of scan.repos) {
    const segments = relativePathSegments(repo.path, scan.selectedPath)
    const folderSegments = segments.slice(0, -1)
    let current = root
    for (const segment of folderSegments) {
      const key = current.key ? `${current.key}/${segment}` : segment
      let child = current.folders.get(segment)
      if (!child) {
        child = { key, name: segment, folders: new Map(), repos: [] }
        current.folders.set(segment, child)
      }
      current = child
    }
    current.repos.push(repo)
  }

  const rows: TreeRow[] = []
  const appendFolder = (folder: TreeFolder, depth: number): void => {
    rows.push({
      type: 'folder',
      key: folder.key,
      name: folder.name,
      depth,
      repoCount: countFolderRepos(folder)
    })
    for (const repo of folder.repos) {
      appendRepoRow(rows, repo, depth + 1, scan.selectedPath)
    }
    for (const child of folder.folders.values()) {
      appendFolder(child, depth + 1)
    }
  }

  for (const repo of root.repos) {
    appendRepoRow(rows, repo, 0, scan.selectedPath)
  }
  for (const folder of root.folders.values()) {
    appendFolder(folder, 0)
  }
  return rows
}

function NestedRepoSelectAllRow({
  total,
  selectedCount,
  disabled,
  onToggle
}: {
  total: number
  selectedCount: number
  disabled: boolean
  onToggle: () => void
}) {
  const allSelected = total > 0 && selectedCount === total
  const noneSelected = selectedCount === 0
  const isMixed = !allSelected && !noneSelected
  const handleCheckboxRef = useCallback(
    (checkbox: HTMLInputElement | null) => {
      if (checkbox) {
        checkbox.indeterminate = isMixed
      }
    },
    [isMixed]
  )
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/50">
      <input
        ref={handleCheckboxRef}
        type="checkbox"
        className="size-3.5"
        checked={allSelected}
        disabled={disabled}
        onChange={onToggle}
        aria-label={allSelected ? 'Deselect all' : 'Select all'}
      />
      <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">
        {allSelected ? 'Deselect all' : 'Select all'}
      </span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
        {selectedCount} of {total} selected
      </span>
    </label>
  )
}

export function NestedRepoTreePreview({
  scan,
  selectedPaths,
  onSelectedPathsChange,
  disabled = false,
  className
}: {
  scan: NestedRepoScanResult
  selectedPaths: Set<string>
  onSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  disabled?: boolean
  className?: string
}) {
  const rows = useMemo(() => buildRows(scan), [scan])

  return (
    <div
      className={cn(
        'flex max-h-64 min-h-0 min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-border bg-background/60',
        className
      )}
    >
      <NestedRepoSelectAllRow
        total={scan.repos.length}
        selectedCount={selectedPaths.size}
        disabled={disabled}
        onToggle={() => {
          onSelectedPathsChange((previous) => {
            if (previous.size === scan.repos.length) {
              return new Set()
            }
            return new Set(scan.repos.map((repo) => repo.path))
          })
        }}
      />
      <ul className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {rows.map((row) =>
          row.type === 'folder' ? (
            <li
              key={`folder:${row.key}`}
              className="flex min-w-0 max-w-full items-center gap-2.5 overflow-hidden border-t border-border bg-muted/20 px-3 py-2 text-sm"
              style={{ paddingLeft: 12 + row.depth * 18 }}
            >
              <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
                {row.name}
              </span>
              <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] leading-none font-medium text-muted-foreground">
                Project group
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {repoCountLabel(row.repoCount)}
              </span>
            </li>
          ) : (
            <li key={row.repo.path}>
              <label
                className="flex min-w-0 max-w-full cursor-pointer items-center gap-2.5 overflow-hidden border-t border-border px-3 py-2 text-sm hover:bg-accent"
                style={{ paddingLeft: 12 + row.depth * 18 }}
              >
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={selectedPaths.has(row.repo.path)}
                  disabled={disabled}
                  onChange={(event) => {
                    onSelectedPathsChange((previous) => {
                      const next = new Set(previous)
                      if (event.target.checked) {
                        next.add(row.repo.path)
                      } else {
                        next.delete(row.repo.path)
                      }
                      return next
                    })
                  }}
                />
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
                    selectedPaths.has(row.repo.path) ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {row.repo.displayName}
                </span>
                <span className="ml-auto min-w-0 max-w-[52%] truncate text-right font-mono text-[11px] text-muted-foreground">
                  {row.pathLabel}
                </span>
              </label>
            </li>
          )
        )}
      </ul>
    </div>
  )
}
