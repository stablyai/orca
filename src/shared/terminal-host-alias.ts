import { z } from 'zod'
import { parseExecutionHostId } from './execution-host'
import { isTerminalLeafId } from './stable-pane-id'
import { isValidHostTerminalTabId } from './terminal-tab-id'
import { toWebTerminalSurfaceTabId } from './terminal-surface-id'

export const terminalHostAliasSchema = z.object({
  executionHostId: z.custom<`runtime:${string}`>(
    (value) => typeof value === 'string' && parseExecutionHostId(value)?.kind === 'runtime'
  ),
  worktreeId: z.string().min(1),
  tabId: z.string().refine(isValidHostTerminalTabId),
  leafId: z.string().refine(isTerminalLeafId)
})

export type TerminalHostAlias = z.infer<typeof terminalHostAliasSchema>

export function terminalHostAliasMatchesTab(alias: TerminalHostAlias, tabId: string): boolean {
  return toWebTerminalSurfaceTabId(alias.tabId) === tabId
}
