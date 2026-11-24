import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

type SparseSelectedDirectoryListProps = {
  directories: string[]
  disabled: boolean
  onRemove: (directory: string) => void
}

export function SparseSelectedDirectoryList({
  directories,
  disabled,
  onRemove
}: SparseSelectedDirectoryListProps): React.JSX.Element {
  const t = useTranslate()
  if (directories.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        {t('sparsePreset.noDirectories', 'No folders added yet.')}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-border px-2 py-2">
      {directories.map((directory) => (
        <span
          key={directory}
          title={directory}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted py-1 pr-1 pl-2 font-mono text-[11px]"
        >
          <span className="truncate">{directory}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => onRemove(directory)}
            aria-label={t('sparsePreset.removePath', 'Remove {{name}}', {
              name: directory
            })}
            className="shrink-0"
          >
            <X />
          </Button>
        </span>
      ))}
    </div>
  )
}
