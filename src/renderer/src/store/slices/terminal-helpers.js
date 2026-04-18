import { detectAgentStatusFromTitle } from '@/lib/agent-status';
export function emptyLayoutSnapshot() {
    return {
        root: null,
        activeLeafId: null,
        expandedLeafId: null
    };
}
export function clearTransientTerminalState(tab, index) {
    return {
        ...tab,
        ptyId: null,
        title: getResetTitle(tab, index)
    };
}
function getResetTitle(tab, index) {
    const fallbackTitle = tab.customTitle?.trim() || tab.defaultTitle?.trim() || `Terminal ${index + 1}`;
    return detectAgentStatusFromTitle(tab.title) ? fallbackTitle : tab.title;
}
