import type { LoadedMcpConfigInspection } from '../../../../runtime/mcp/configuration/mcp-config-inspection'
import { useTranslate } from '@/i18n/use-translate'

export function McpMissingConfigList({
  missingConfigs
}: {
  missingConfigs: LoadedMcpConfigInspection[]
}): React.JSX.Element | null {
  const t = useTranslate()
  if (missingConfigs.length === 0) {
    return null
  }

  return (
    <div data-settings-row="" className="space-y-1.5 py-3">
      <p className="text-[11px] text-muted-foreground">
        {t('auto.components.settings.McpConfigSection.4d16a0d9ac', 'Checked')}
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
