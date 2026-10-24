import { useEffect, useState } from 'react'
import { acquirePluginSyntaxLanguage } from '@/lib/monaco-languages/plugin-syntax-runtime'
import { matchPluginSyntax, usePluginSyntaxes } from '@/store/plugin-syntax-packs'

/** The editor language for a file: a plugin syntax fills in only where Orca shows plain text. */
export function usePluginSyntaxLanguage(filePath: string, coreLanguage: string): string {
  const syntaxes = usePluginSyntaxes()
  const syntax = coreLanguage === 'plaintext' ? matchPluginSyntax(syntaxes, filePath) : null
  const key = syntax ? `${syntax.id}@${syntax.revision}` : null
  const [language, setLanguage] = useState<{ key: string; id: string } | null>(null)

  useEffect(() => {
    if (!syntax || !key) {
      return
    }
    const lease = acquirePluginSyntaxLanguage(syntax)
    setLanguage(lease ? { key, id: lease.languageId } : null)
    return () => lease?.release()
    // Why key: a new revision must take a new lease even though the entry object changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return language && language.key === key ? language.id : coreLanguage
}
