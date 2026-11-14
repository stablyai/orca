export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex'
}

export function usesModelSpecificAcpEfforts(agent: string): boolean {
  return agent === 'opencode' || agent === 'opencode2' || agent === 'omp'
}

/** Agents whose per-model effort menus are learned up front and preserved across unobserved live session menus. */
export function retainsModelSpecificAcpEfforts(agent: string): boolean {
  return usesModelSpecificAcpEfforts(agent) || agent === 'antigravity'
}

export function usesInstalledAgentModelCatalog(agent: string, coherentCatalog?: boolean): boolean {
  return coherentCatalog === true && independentAgentModelCatalog(agent)
}
