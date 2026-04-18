import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config';
function quoteStartupArg(value, platform) {
    if (platform === 'win32') {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function buildAgentStartupPlan(args) {
    const { agent, prompt, cmdOverrides, platform } = args;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
        return null;
    }
    const config = TUI_AGENT_CONFIG[agent];
    const baseCommand = cmdOverrides[agent] ?? config.launchCmd;
    const quotedPrompt = quoteStartupArg(trimmedPrompt, platform);
    if (config.promptInjectionMode === 'argv') {
        return {
            launchCommand: `${baseCommand} ${quotedPrompt}`,
            expectedProcess: config.expectedProcess,
            followupPrompt: null
        };
    }
    if (config.promptInjectionMode === 'flag-prompt') {
        return {
            launchCommand: `${baseCommand} --prompt ${quotedPrompt}`,
            expectedProcess: config.expectedProcess,
            followupPrompt: null
        };
    }
    if (config.promptInjectionMode === 'flag-prompt-interactive') {
        return {
            launchCommand: `${baseCommand} --prompt-interactive ${quotedPrompt}`,
            expectedProcess: config.expectedProcess,
            followupPrompt: null
        };
    }
    return {
        launchCommand: baseCommand,
        expectedProcess: config.expectedProcess,
        // Why: several agent TUIs either lack a documented "start interactive
        // session with this prompt" flag or vary too much across versions. For
        // those agents Orca launches the TUI first, then types the composed prompt
        // into the live session once the agent owns the terminal.
        followupPrompt: trimmedPrompt
    };
}
export function isShellProcess(processName) {
    const normalized = processName.trim().toLowerCase();
    return (normalized === '' ||
        normalized === 'bash' ||
        normalized === 'zsh' ||
        normalized === 'sh' ||
        normalized === 'fish' ||
        normalized === 'cmd.exe' ||
        normalized === 'powershell.exe' ||
        normalized === 'pwsh.exe' ||
        normalized === 'nu');
}
