import type { TuiAgent } from './types';
export type AgentPromptInjectionMode = 'argv' | 'flag-prompt' | 'flag-prompt-interactive' | 'stdin-after-start';
export type TuiAgentConfig = {
    detectCmd: string;
    launchCmd: string;
    expectedProcess: string;
    promptInjectionMode: AgentPromptInjectionMode;
};
export declare const TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig>;
