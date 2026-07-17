export const SERVICE_PORT_BASE = 20000
export const SERVICE_PORTS_PER_SLOT = 10

export function deriveServiceSlug(worktreeName: string, slot: number): string {
  const suffix = `-s${slot}`
  const base =
    worktreeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40 - suffix.length)
      .replace(/-+$/g, '') || 'worktree'
  return `${base}${suffix}`
}

export function buildServiceContextEnv(slug: string, slot: number): Record<string, string> {
  const env: Record<string, string> = {
    ORCA_WORKTREE_SLUG: slug,
    ORCA_SERVICE_SLOT: String(slot)
  }
  for (let i = 0; i < SERVICE_PORTS_PER_SLOT; i++) {
    env[`ORCA_PORT_${i}`] = String(SERVICE_PORT_BASE + slot * SERVICE_PORTS_PER_SLOT + i)
  }
  return env
}

export function resolveServiceEnv(
  template: Record<string, string> | undefined,
  contextEnv: Record<string, string>
): Record<string, string> {
  if (!template) {
    return {}
  }
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(template)) {
    resolved[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) =>
      name in contextEnv ? contextEnv[name] : match
    )
  }
  return resolved
}
