export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex' || agent === 'trae'
}

export function usesModelSpecificAcpEfforts(agent: string): boolean {
  return agent === 'opencode' || agent === 'opencode2' || agent === 'omp'
}

export function usesInstalledAgentModelCatalog(agent: string, coherentCatalog?: boolean): boolean {
  return coherentCatalog === true && independentAgentModelCatalog(agent)
}
