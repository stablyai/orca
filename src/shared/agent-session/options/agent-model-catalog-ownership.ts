export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex'
}

/** Identifies ACP agents whose effort menus require separate discovery for each model. */
export function usesModelSpecificAcpEfforts(agent: string): boolean {
  return agent === 'opencode' || agent === 'opencode2' || agent === 'omp'
}

export function usesInstalledAgentModelCatalog(agent: string, coherentCatalog?: boolean): boolean {
  return coherentCatalog === true && independentAgentModelCatalog(agent)
}
