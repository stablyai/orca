import { monaco } from '@/lib/monaco-setup'

// Monaco in Orca is api-only — basic-languages are opt-in. Without registering
// SQL tokens the query editor silently renders plaintext (red-team F13). Loaded
// lazily and once so non-database users don't pay the cost at startup.
let sqlRegistrationPromise: Promise<void> | null = null

export function ensureSqlLanguageRegistered(): Promise<void> {
  sqlRegistrationPromise ??= import('monaco-editor/esm/vs/basic-languages/sql/sql.js').then(
    ({ conf, language }) => {
      if (!monaco.languages.getLanguages().some((item) => item.id === 'sql')) {
        monaco.languages.register({ id: 'sql', extensions: ['.sql'], aliases: ['SQL', 'sql'] })
      }
      monaco.languages.setLanguageConfiguration('sql', conf)
      monaco.languages.setMonarchTokensProvider('sql', language)
    }
  )
  return sqlRegistrationPromise
}
