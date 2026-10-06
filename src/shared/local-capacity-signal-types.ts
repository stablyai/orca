/** Why a local host looks too weak to run new work itself, for routing decisions. */
export type LocalCapacitySignal = {
  onBattery: boolean
  lowMemory: boolean
  lowCpu: boolean
  /**
   * Short English detail phrases for each true flag. Nothing renders these: routing reads the
   * flags themselves and the renderer localizes its own copy per flag.
   */
  reasons: string[]
}
