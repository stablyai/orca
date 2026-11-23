// Orca's own plugins' names and descriptions in the UI language. Keys hash the English, so a manifest
// edit shows its new English until it is translated again; other plugins show as written.
import { englishTextHash } from '../text/english-text-hash'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function pluginDisplayText(english: string, official: boolean, t: Translate): string {
  // Why the inline template: catalog checks keep keys whose `t(` call names this prefix.
  return english && official
    ? t(`plugins.displayText.t${englishTextHash(english)}`, english)
    : english
}
