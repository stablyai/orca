export const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()

export const pendingSpawnGenerationByPaneKey = new Map<string, number>()
