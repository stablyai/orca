export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex'
}

/** Claude and Codex run at standard speed until Fast is picked; ACP agents keep each model's own default. */
export function unpickedFastModeIsOff(agent: string): boolean {
  return independentAgentModelCatalog(agent)
}

/** Live chats list only the current model's options; the session-free listing knows the rest. */
export function fillsLiveModelsFromCatalog(agent: string): boolean {
  return usesModelSpecificAcpEfforts(agent) || agent === 'cursor'
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
