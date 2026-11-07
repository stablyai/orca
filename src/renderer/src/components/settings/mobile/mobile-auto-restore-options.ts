import { translate } from '@/i18n/i18n'

export const AUTO_RESTORE_FIT_OPTIONS: { value: string; label: string; ms: number | null }[] = [
  {
    value: 'indefinite',
    get label() {
      return translate(
        'auto.components.settings.MobilePane.aa1263e881',
        'Keep at phone size (default)'
      )
    },
    ms: null
  },
  {
    value: '60s',
    get label() {
      return translate('auto.components.settings.MobilePane.c474aa09d8', 'After 1 minute')
    },
    ms: 60_000
  },
  {
    value: '5m',
    get label() {
      return translate('auto.components.settings.MobilePane.d4ba07d914', 'After 5 minutes')
    },
    ms: 5 * 60_000
  },
  {
    value: '30m',
    get label() {
      return translate('auto.components.settings.MobilePane.ff865419dc', 'After 30 minutes')
    },
    ms: 30 * 60_000
  }
]

export function autoRestoreValueFromMs(ms: number | null | undefined): string {
  if (ms == null) {
    return 'indefinite'
  }
  const exact = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  return exact ? exact.value : 'indefinite'
}
