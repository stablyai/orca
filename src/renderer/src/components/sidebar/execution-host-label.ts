import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function translateLocalExecutionHostLabel(
  label: string = getLocalExecutionHostLabel(),
  t: Translate = translate
): string {
  if (label === 'Local Windows') {
    return t('auto.components.sidebar.hostSection.localWindows', 'Local Windows')
  }
  if (label === 'Local Mac') {
    return t('auto.components.sidebar.hostSection.localMac', 'Local Mac')
  }
  if (label === 'Local Linux') {
    return t('auto.components.sidebar.hostSection.localLinux', 'Local Linux')
  }
  if (label === 'This computer') {
    return t('auto.components.sidebar.hostSection.thisComputer', 'This computer')
  }
  return label
}

/** Map shared English host labels (Local *, All hosts) at display time. */
export function translateExecutionHostLabel(label: string, t: Translate = translate): string {
  if (label === 'All hosts') {
    return t('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts')
  }
  return translateLocalExecutionHostLabel(label, t)
}

export function translateHostDisplayLabel(
  host: { label: string; isDefaultLocalLabel?: boolean },
  t: Translate = translate
): string {
  return host.isDefaultLocalLabel ? translateExecutionHostLabel(host.label, t) : host.label
}

export function translateExecutionHostDetail(detail: string): string {
  if (detail === 'Host') {
    return translate('auto.components.sidebar.hostSection.host', 'Host')
  }
  if (detail === 'This computer') {
    return translate('auto.components.sidebar.hostSection.thisComputer', 'This computer')
  }
  return detail
}

export function getTranslatedExecutionHostLabel(
  id: ExecutionHostScope | null | undefined,
  t: Translate = translate
): string {
  const label = getExecutionHostLabel(id)
  return id === LOCAL_EXECUTION_HOST_ID || id === ALL_EXECUTION_HOSTS_SCOPE
    ? translateExecutionHostLabel(label, t)
    : label
}
