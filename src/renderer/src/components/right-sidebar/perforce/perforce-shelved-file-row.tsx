import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { PerforceShelvedFile } from '../../../../../shared/perforce/perforce-types'

/** Shelved file row: click diffs it against the workspace; right-click opens it without a diff. */
export function PerforceShelvedFileRow({
  file,
  onDiff,
  onOpen,
  onUnshelve
}: {
  file: PerforceShelvedFile
  onDiff: () => void
  onOpen: () => void
  onUnshelve: () => void
}) {
  const source = file.path ?? file.depotPath
  const slash = source.lastIndexOf('/')
  const name = source.slice(slash + 1)
  const dir = slash === -1 ? '' : source.slice(0, slash)
  const mapped = file.path !== undefined
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          disabled={!mapped}
          className="flex w-full min-w-0 items-center gap-2 px-2 py-0.5 text-left text-[13px] hover:bg-accent disabled:opacity-60"
          onClick={onDiff}
          title={file.depotPath}
        >
          <span className="w-3 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">
            S
          </span>
          <span className="truncate">{name}</span>
          {dir ? <span className="truncate text-xs text-muted-foreground">{dir}</span> : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!mapped} onSelect={onOpen}>
          Open shelved file
        </ContextMenuItem>
        <ContextMenuItem onSelect={onUnshelve}>Unshelve file</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
