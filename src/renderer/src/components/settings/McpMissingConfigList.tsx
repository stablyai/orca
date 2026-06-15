import type { LoadedMcpConfigInspection } from './McpConfigFileRow'
import { translate } from '@/i18n/i18n'

export function McpMissingConfigList({
  missingConfigs
}: {
  missingConfigs: LoadedMcpConfigInspection[]
}): React.JSX.Element | null {
  if (missingConfigs.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5 border-t border-border/50 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">
        {translate('auto.components.settings.McpConfigSection.4d16a0d9ac', 'Checked')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {missingConfigs.map((config) => (
          <span
            key={config.candidate.relativePath}
            className="rounded-md border border-border/50 bg-background/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {config.candidate.relativePath}
          </span>
        ))}
      </div>
    </div>
  )
}
