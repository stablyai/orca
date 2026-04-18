import type { TuiAgent } from '../../../shared/types';
export type AgentStartupPlan = {
    launchCommand: string;
    expectedProcess: string;
    followupPrompt: string | null;
};
export declare function buildAgentStartupPlan(args: {
    agent: TuiAgent;
    prompt: string;
    cmdOverrides: Partial<Record<TuiAgent, string>>;
    platform: NodeJS.Platform;
}): AgentStartupPlan | null;
export declare function isShellProcess(processName: string): boolean;
