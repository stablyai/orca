import { translate } from '@/i18n/i18n'

// Why English: tab labels persist in session state that older builds and remote clients read verbatim.
export const SIMULATOR_DEFAULT_TAB_LABEL = 'Mobile Emulator'

export function formatSimulatorTabLabel(label: string | null | undefined): string {
  if (!label || label === SIMULATOR_DEFAULT_TAB_LABEL) {
    return translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator')
  }
  return label
}
