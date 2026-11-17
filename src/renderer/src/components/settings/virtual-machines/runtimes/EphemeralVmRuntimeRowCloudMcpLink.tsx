import type React from 'react'
import { ChevronRight } from 'lucide-react'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../../ui/button'

/** A VM runtime row, plus (Orca Cloud) a link to MCP servers under a running cloud VM's row. */
export function EphemeralVmRuntimeRowCloudFrame({
  runtime,
  children
}: {
  runtime: EphemeralVmRuntimeRecord
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  // MCP sync lives in Settings › Orca Cloud › MCP servers; a running cloud VM links there.
  const showMcpLink =
    runtime.recipe?.provider === 'orca-cloud' &&
    runtime.status === 'running' &&
    Boolean(runtime.runtimeEnvironmentId)
  return (
    <div>
      {children}
      {showMcpLink ? (
        <div className="px-4 pb-3 pl-8">
          <Button
            type="button"
            variant="quiet"
            size="xs"
            onClick={() => openSettingsTarget({ pane: 'cloud-mcp', repoId: null })}
            aria-label={t('settings.orcaCloud.mcp.openFor', 'MCP servers for {{name}}', {
              name: runtime.workspaceName || t('settings.orcaCloud.mcp.unnamed', 'Cloud workspace')
            })}
          >
            {t('cloudMcpSync.title', 'MCP servers')}
            <ChevronRight className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
