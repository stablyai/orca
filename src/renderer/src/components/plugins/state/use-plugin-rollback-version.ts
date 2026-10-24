import { useEffect, useState } from 'react'

/** The version "Roll back" would restore, read when asked; null while loading or when there is none. */
export function usePluginRollbackVersion(pluginKey: string | null): string | null {
  const [loaded, setLoaded] = useState<{ pluginKey: string; version: string | null } | null>(null)

  useEffect(() => {
    if (!pluginKey) {
      return
    }
    let stale = false
    window.api.plugins
      .getRollbackVersion({ pluginKey })
      .then((version) => {
        if (!stale) {
          setLoaded({ pluginKey, version })
        }
      })
      .catch((cause: unknown) => {
        console.warn('[plugins] rollback version read failed:', cause)
      })
    return () => {
      stale = true
    }
  }, [pluginKey])

  return loaded && loaded.pluginKey === pluginKey ? loaded.version : null
}
