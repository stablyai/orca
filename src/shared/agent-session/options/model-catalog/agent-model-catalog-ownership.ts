export function independentAgentModelCatalog(agent: string): boolean {
  return agent === 'claude' || agent === 'codex' || agent === 'trae'
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
  return agent === 'opencode' || agent === 'opencode2' || agent === 'omp' || agent === 'kilo'
}

/** Its listing's efforts stay unconfirmed until a chat runs the model, so a send refuses one the
 *  model lacks rather than running at the agent's default. */
export function confirmsListedEffortAtSend(agent: string): boolean {
  return agent === 'kiro'
}

export function usesInstalledAgentModelCatalog(agent: string, coherentCatalog?: boolean): boolean {
  return coherentCatalog === true && independentAgentModelCatalog(agent)
}
