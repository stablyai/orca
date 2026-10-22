import type { AiVaultAgent } from './ai-vault-types'

/** One agent's history as counted while its folders and databases are listed. */
export type AiVaultScanAgentProgress = {
  agent: AiVaultAgent
  /** Distinct files: a hard link or a linked folder reaching the same file counts once. */
  files: number
  /** SQLite stores holding this agent's sessions. */
  databases: number
  /** A folder or database of this agent is still being listed. */
  walking: boolean
}

/** The scanner process's view of the scan it is running. */
export type AiVaultScanWork = {
  stage: 'finding' | 'reading'
  agents: AiVaultScanAgentProgress[]
  /** Transcripts read so far, out of the ones this scan will read. */
  read: { done: number; total: number }
}

/** One local Session History scan entry, as main pushes it to windows. */
export type AiVaultScanProgress = Omit<AiVaultScanWork, 'stage'> & {
  scanId: string
  stage: AiVaultScanWork['stage'] | 'finished'
  startedAt: number
  settledAt: number | null
}

export type AiVaultScanProgressUpdate = {
  scanKey: string
  progress: AiVaultScanProgress | null
}

export const AI_VAULT_SCAN_PROGRESS_CHANNEL = 'aiVault:scanProgress'
