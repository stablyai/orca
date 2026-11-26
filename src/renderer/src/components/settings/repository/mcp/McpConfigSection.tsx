import { AlertCircle, FileCode2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { Button } from '../../../ui/button'
import { McpConfigFileRow } from './McpConfigFileRow'
import { McpMissingConfigList } from './McpMissingConfigList'
import { formatMcpConfigSummary } from './mcp-config-summary'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { useRepoMcpConfigs } from './use-repo-mcp-configs'

type McpConfigSectionProps = {
  repo: Repo
}

export function McpConfigSection({ repo }: McpConfigSectionProps): React.JSX.Element {
  const {
    t,
    connectionId,
    configs,
    loading,
    loadConfigs,
    visibleConfigs,
    missingConfigs,
    inspectionUnavailable,
    inspectionUnavailableMessage,
    canCreateStarter,
    createConfirm,
    handleOpen,
    handleCreateStarter
  } = useRepoMcpConfigs(repo)
  return (
    <SettingsGroup
      title={t('auto.components.settings.McpConfigSection.283bebb198', 'MCP configs')}
      description={
        <>
          {t(
            'auto.components.settings.McpConfigSection.96f5609b04',
            'Inspect MCP server definitions that agents can use while working in this repo.'
          )}
          {connectionId ? (
            <span className="block">
              {t(
                'auto.components.settings.McpConfigSection.6bac9ddfc6',
                'SSH repos are read through the remote filesystem. Starter creation is limited to the workspace root config.'
              )}
            </span>
          ) : null}
        </>
      }
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadConfigs()}
            aria-label={t(
              'auto.components.settings.McpConfigSection.f34c152dc0',
              'Refresh MCP configs'
            )}
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          {canCreateStarter ? (
            <Button
              variant={createConfirm ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => void handleCreateStarter()}
            >
              <Plus className="size-3.5" />
              {createConfirm
                ? t('auto.components.settings.McpConfigSection.0a5c1ead54', 'Create empty config')
                : t('auto.components.settings.McpConfigSection.82436439eb', 'Add MCP config')}
            </Button>
          ) : null}
        </div>
      }
    >
      <div
        data-settings-row=""
        className="flex items-center justify-between py-3 text-xs text-muted-foreground"
      >
        <span>{formatMcpConfigSummary(configs, t)}</span>
        {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      </div>
      {visibleConfigs.length === 0 ? (
        <div
          data-settings-row=""
          className="flex items-start gap-2 py-3 text-xs text-muted-foreground"
        >
          {inspectionUnavailable ? (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <FileCode2 className="mt-0.5 size-3.5 shrink-0" />
          )}
          {inspectionUnavailable ? (
            <span>{inspectionUnavailableMessage}</span>
          ) : (
            <span>
              {t(
                'auto.components.settings.McpConfigSection.b900cd6282',
                'No MCP config found. Add an empty workspace config when you want this repo to define its own MCP servers.'
              )}
            </span>
          )}
        </div>
      ) : (
        visibleConfigs.map((config) => (
          <McpConfigFileRow
            key={config.candidate.relativePath}
            config={config}
            onOpen={handleOpen}
          />
        ))
      )}

      {!inspectionUnavailable ? <McpMissingConfigList missingConfigs={missingConfigs} /> : null}
    </SettingsGroup>
  )
}
