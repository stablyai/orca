import { formatCliUserFacingDetail } from '@/lib/cli-emulator-user-facing-copy'
import { translate } from '@/i18n/i18n'

export function cliDetailOrFallback(
  detail: string | null | undefined,
  key: string,
  fallback: string
): string {
  return formatCliUserFacingDetail(detail) || translate(key, fallback)
}
