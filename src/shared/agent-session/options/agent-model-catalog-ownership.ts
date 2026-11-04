export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex'
}

export function usesInstalledAgentModelCatalog(agent: string, coherentCatalog?: boolean): boolean {
  return coherentCatalog === true && independentAgentModelCatalog(agent)
}
