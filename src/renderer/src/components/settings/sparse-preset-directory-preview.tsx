import { translate } from '@/i18n/i18n'

export function SparsePresetDirectoryPreview({
  directories
}: {
  directories: string[]
}): React.JSX.Element {
  const visibleDirectories = directories.slice(0, 6)
  const hiddenCount = directories.length - visibleDirectories.length

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleDirectories.map((directory) => (
        <span
          key={directory}
          className="min-w-0 max-w-full truncate rounded-md border border-border/50 bg-muted/35 px-2 py-1 font-mono text-[11px] text-foreground/80"
          title={directory}
        >
          {directory}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className="rounded-md border border-border/50 bg-muted/35 px-2 py-1 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.SparsePresetSettingsSection.8b64731aaf',
            '+{{value0}} more',
            { value0: hiddenCount }
          )}
        </span>
      ) : null}
    </div>
  )
}
