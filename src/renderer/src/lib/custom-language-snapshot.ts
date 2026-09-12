import type { CustomLanguageSnapshot } from '../../../shared/custom-languages'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { setCustomLanguageAssociations } from './custom-language-associations'

let snapshotPromise: Promise<CustomLanguageSnapshot> | undefined

export function loadCustomLanguageSnapshot(): Promise<CustomLanguageSnapshot> {
  snapshotPromise ??= (async () => {
    let snapshot: CustomLanguageSnapshot = { languages: [], grammars: {}, diagnostics: [] }
    try {
      // Grammars belong to this desktop client, including when its workspace is remote.
      if (window.api?.settings?.getCustomLanguages) {
        snapshot = await withTimeout(
          window.api.settings.getCustomLanguages().catch((error) => ({
            languages: [],
            grammars: {},
            diagnostics: [`Could not load custom languages: ${String(error)}`]
          })),
          3000,
          {
            languages: [],
            grammars: {},
            diagnostics: [
              'Custom language loading timed out. Check languages.json and restart Orca.'
            ]
          }
        )
      }
    } catch (error) {
      snapshot.diagnostics.push(`Could not load custom languages: ${String(error)}`)
    }
    setCustomLanguageAssociations(snapshot.languages)
    return snapshot
  })()
  return snapshotPromise
}
