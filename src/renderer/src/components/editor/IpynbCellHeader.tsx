import { Braces, FileCode2, Play } from 'lucide-react'
import type { IpynbCell, IpynbCellKind } from './ipynb-parse'

export function getIpynbCellExecutionLabel(cell: IpynbCell): string {
  return cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : cell.kind
}

export function IpynbCellKindIcon({ kind }: { kind: IpynbCellKind }): React.JSX.Element {
  const Icon = kind === 'code' ? Play : kind === 'markdown' ? FileCode2 : Braces
  return <Icon className="size-3.5" aria-hidden="true" />
}

export function IpynbCellHeader({
  cell,
  index
}: {
  cell: IpynbCell
  index: number
}): React.JSX.Element {
  return (
    <div
      data-testid="ipynb-cell-header"
      className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <IpynbCellKindIcon kind={cell.kind} />
      <span className="font-mono">{getIpynbCellExecutionLabel(cell)}</span>
      <span className="ml-auto font-mono">#{index + 1}</span>
    </div>
  )
}
