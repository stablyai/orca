import type { TerminalTab, Worktree } from '../../../shared/types';
export { type AgentStatus, detectAgentStatusFromTitle, clearWorkingIndicators, createAgentStatusTracker, normalizeTerminalTitle, isGeminiTerminalTitle, isClaudeAgent, getAgentLabel } from '../../../shared/agent-detection';
import { type AgentStatus } from '../../../shared/agent-detection';
type AgentQueryArgs = {
    tabsByWorktree: Record<string, TerminalTab[]>;
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>;
    worktreesByRepo: Record<string, Worktree[]>;
};
export type WorkingAgentEntry = {
    label: string;
    status: AgentStatus;
    tabId: string;
    paneId: number | null;
};
export type WorktreeAgents = {
    agents: WorkingAgentEntry[];
};
export declare function getWorkingAgentsPerWorktree({ tabsByWorktree, runtimePaneTitlesByTabId, worktreesByRepo }: AgentQueryArgs): Record<string, WorktreeAgents>;
export declare function countWorkingAgents({ tabsByWorktree, runtimePaneTitlesByTabId, worktreesByRepo }: AgentQueryArgs): number;
