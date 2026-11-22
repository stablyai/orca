import { Clock } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslate } from '@/i18n/use-translate'
import { wslHostsAvailable } from '@/runtime/hosts/wsl/use-wsl-hosts-enabled'
import { useAppStore } from '@/store'
import { isWslHostRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'

export function WslRuntimeUpdateStatusSegment(): React.JSX.Element | null {
  const t = useTranslate()
  const pendingHostIds = useAppStore(
    useShallow((state) =>
      !wslHostsAvailable() || state.wslHostServerFiles === 'missing'
        ? []
        : state.runtimeEnvironments
            .filter(
              (host) =>
                isWslHostRuntimeEnvironment(host) && state.wslHostStatuses[host.id]?.deferredUpdate
            )
            .map((host) => host.id)
    )
  )
  const [firstHostId] = pendingHostIds
  if (!firstHostId) {
    return null
  }

  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-2xs hover:bg-accent"
      onClick={() => {
        const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
        openSettingsPage()
        openSettingsTarget({
          pane: 'servers',
          repoId: null,
          sectionId: pendingHostIds.length === 1 ? firstHostId : 'wsl-hosts'
        })
      }}
    >
      <Clock aria-hidden="true" className="size-3 text-muted-foreground" />
      {t(
        'auto.components.status.bar.WslRuntimeUpdateStatusSegment.deferred',
        '{{count}} WSL runtime updates deferred',
        { count: pendingHostIds.length, defaultValue_one: 'WSL runtime update deferred' }
      )}
    </button>
  )
}
