import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Opens Settings › Agents on `host`, where each agent's Command setting lives. */
export function openAgentSettingsAction(
  host: RuntimeClientTarget | undefined,
  t: Translate = translate
): { label: string; disabled: false; onClick: () => void } {
  return {
    label: t('components.native-chat.install.openAgentSettings', 'Open Settings'),
    disabled: false,
    onClick: () => {
      const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
      openSettingsTarget({ pane: 'agents', repoId: null, ...(host ? { hostScope: host } : {}) })
      openSettingsPage()
    }
  }
}
