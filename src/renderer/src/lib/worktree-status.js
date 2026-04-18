import { detectAgentStatusFromTitle } from '@/lib/agent-status';
const STATUS_LABELS = {
    active: 'Active',
    working: 'Working',
    permission: 'Needs permission',
    inactive: 'Inactive'
};
export function getWorktreeStatus(tabs, browserTabs) {
    const liveTabs = tabs.filter((tab) => tab.ptyId);
    if (liveTabs.some((tab) => detectAgentStatusFromTitle(tab.title) === 'permission')) {
        return 'permission';
    }
    if (liveTabs.some((tab) => detectAgentStatusFromTitle(tab.title) === 'working')) {
        return 'working';
    }
    if (liveTabs.length > 0 || browserTabs.length > 0) {
        // Why: browser-only worktrees are still active from the user's point of
        // view even when they have no PTY-backed terminal. The sidebar filter
        // already treats them as active, so every navigation surface must reuse
        // that rule instead of showing a misleading inactive dot.
        return 'active';
    }
    return 'inactive';
}
export function getWorktreeStatusLabel(status) {
    return STATUS_LABELS[status];
}
