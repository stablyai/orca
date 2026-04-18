// Why: the new-workspace handoff depends on three pieces of per-agent
// knowledge staying in sync: how Orca detects the agent on PATH, which binary
// it actually launches, and whether the initial prompt should be passed as an
// argv flag/argument or typed into the interactive session after startup.
// Centralizing that metadata prevents the picker, launcher, and preflight
// checks from quietly drifting apart as new agents are added.
export const TUI_AGENT_CONFIG = {
    claude: {
        detectCmd: 'claude',
        launchCmd: 'claude',
        expectedProcess: 'claude',
        promptInjectionMode: 'argv'
    },
    codex: {
        detectCmd: 'codex',
        launchCmd: 'codex',
        expectedProcess: 'codex',
        promptInjectionMode: 'argv'
    },
    opencode: {
        detectCmd: 'opencode',
        launchCmd: 'opencode',
        expectedProcess: 'opencode',
        promptInjectionMode: 'flag-prompt'
    },
    pi: {
        detectCmd: 'pi',
        launchCmd: 'pi',
        expectedProcess: 'pi',
        promptInjectionMode: 'argv'
    },
    gemini: {
        detectCmd: 'gemini',
        launchCmd: 'gemini',
        expectedProcess: 'gemini',
        promptInjectionMode: 'flag-prompt-interactive'
    },
    aider: {
        detectCmd: 'aider',
        launchCmd: 'aider',
        expectedProcess: 'aider',
        promptInjectionMode: 'stdin-after-start'
    },
    goose: {
        detectCmd: 'goose',
        launchCmd: 'goose',
        expectedProcess: 'goose',
        promptInjectionMode: 'stdin-after-start'
    },
    amp: {
        detectCmd: 'amp',
        launchCmd: 'amp',
        expectedProcess: 'amp',
        promptInjectionMode: 'stdin-after-start'
    },
    kilo: {
        detectCmd: 'kilo',
        launchCmd: 'kilo',
        expectedProcess: 'kilo',
        promptInjectionMode: 'stdin-after-start'
    },
    kiro: {
        detectCmd: 'kiro',
        launchCmd: 'kiro',
        expectedProcess: 'kiro',
        promptInjectionMode: 'stdin-after-start'
    },
    crush: {
        detectCmd: 'crush',
        launchCmd: 'crush',
        expectedProcess: 'crush',
        promptInjectionMode: 'stdin-after-start'
    },
    aug: {
        detectCmd: 'aug',
        launchCmd: 'aug',
        expectedProcess: 'aug',
        promptInjectionMode: 'stdin-after-start'
    },
    cline: {
        detectCmd: 'cline',
        launchCmd: 'cline',
        expectedProcess: 'cline',
        promptInjectionMode: 'stdin-after-start'
    },
    codebuff: {
        detectCmd: 'codebuff',
        launchCmd: 'codebuff',
        expectedProcess: 'codebuff',
        promptInjectionMode: 'stdin-after-start'
    },
    continue: {
        detectCmd: 'continue',
        launchCmd: 'continue',
        expectedProcess: 'continue',
        promptInjectionMode: 'stdin-after-start'
    },
    cursor: {
        detectCmd: 'cursor-agent',
        launchCmd: 'cursor-agent',
        expectedProcess: 'cursor-agent',
        promptInjectionMode: 'argv'
    },
    droid: {
        detectCmd: 'droid',
        launchCmd: 'droid',
        expectedProcess: 'droid',
        promptInjectionMode: 'argv'
    },
    kimi: {
        detectCmd: 'kimi',
        launchCmd: 'kimi',
        expectedProcess: 'kimi',
        promptInjectionMode: 'stdin-after-start'
    },
    'mistral-vibe': {
        detectCmd: 'mistral-vibe',
        launchCmd: 'mistral-vibe',
        expectedProcess: 'mistral-vibe',
        promptInjectionMode: 'stdin-after-start'
    },
    'qwen-code': {
        detectCmd: 'qwen-code',
        launchCmd: 'qwen-code',
        expectedProcess: 'qwen-code',
        promptInjectionMode: 'stdin-after-start'
    },
    rovo: {
        detectCmd: 'rovo',
        launchCmd: 'rovo',
        expectedProcess: 'rovo',
        promptInjectionMode: 'stdin-after-start'
    },
    hermes: {
        detectCmd: 'hermes',
        launchCmd: 'hermes',
        expectedProcess: 'hermes',
        promptInjectionMode: 'stdin-after-start'
    }
};
