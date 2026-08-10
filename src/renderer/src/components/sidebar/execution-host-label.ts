import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

export function translateLocalExecutionHostLabel(
  label: string = getLocalExecutionHostLabel()
): string {
  if (label === 'Local Windows') {
    return translate('auto.components.sidebar.hostSection.localWindows', 'Local Windows')
  }
  if (label === 'Local Mac') {
    return translate('auto.components.sidebar.hostSection.localMac', 'Local Mac')
  }
  if (label === 'Local Linux') {
    return translate('auto.components.sidebar.hostSection.localLinux', 'Local Linux')
  }
  if (label === 'This computer') {
    return translate('auto.components.sidebar.hostSection.thisComputer', 'This computer')
  }
  return label
}

/** Map shared English host labels (Local *, All hosts) at display time. */
export function translateExecutionHostLabel(label: string): string {
  if (label === 'All hosts') {
    return translate('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts')
  }
  return translateLocalExecutionHostLabel(label)
}

export function getTranslatedExecutionHostLabel(id: ExecutionHostScope): string {
  return translateExecutionHostLabel(getExecutionHostLabel(id))
}
