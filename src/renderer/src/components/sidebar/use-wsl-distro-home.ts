import { useEffect, useState } from 'react'

// Why module-level: `getWslHomeAsync` spawns wsl.exe (5s timeout) — one probe
// per distro per session must bound the cost of reopening the dialog.
const distroHomeCache = new Map<string, Promise<string | null>>()

export function fetchWslDistroHome(distro: string): Promise<string | null> {
  const cached = distroHomeCache.get(distro)
  if (cached) {
    return cached
  }
  const probe = window.api.wsl.getDistroHome(distro).catch(() => null)
  distroHomeCache.set(distro, probe)
  return probe
}

/** UNC path of the distro user's home, or null while unprobed/unresolvable. */
export function useWslDistroHome(distro: string | null | undefined): string | null {
  const [home, setHome] = useState<string | null>(null)
  useEffect(() => {
    if (!distro) {
      setHome(null)
      return
    }
    let cancelled = false
    void fetchWslDistroHome(distro).then((value) => {
      if (!cancelled) {
        setHome(value)
      }
    })
    return () => {
      cancelled = true
    }
  }, [distro])
  return home
}

/** `\\wsl.localhost\<distro>` — the always-valid browse root when home is unprobed. */
export function wslDistroUncRoot(distro: string): string {
  return `\\\\wsl.localhost\\${distro}`
}

/** Initial picker directory for a selected distro: home UNC, else the distro root. */
export function getWslBrowseRoot(
  distro: string | null | undefined,
  homeUnc: string | null | undefined
): string | null {
  return distro ? (homeUnc ?? wslDistroUncRoot(distro)) : null
}
