import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useAppStore } from '../../store';
import { GIT_PANE_SEARCH_ENTRIES } from './git-search';
import { SearchableSetting } from './SearchableSetting';
import { matchesSettingsSearch } from './settings-search';
export { GIT_PANE_SEARCH_ENTRIES };
export function GitPane({ settings, updateSettings, displayedGitUsername }) {
    const searchQuery = useAppStore((s) => s.settingsSearchQuery);
    const visibleSections = [
        matchesSettingsSearch(searchQuery, {
            title: 'Branch Prefix',
            description: 'Prefix added to branch names when creating worktrees.',
            keywords: ['branch naming', 'git username', 'custom']
        }) ? (_jsxs(SearchableSetting, { title: "Branch Prefix", description: "Prefix added to branch names when creating worktrees.", keywords: ['branch naming', 'git username', 'custom'], className: "space-y-3", children: [_jsx("div", { className: "flex w-fit gap-1 rounded-md border border-border/50 p-1", children: ['git-username', 'custom', 'none'].map((option) => (_jsx("button", { onClick: () => updateSettings({ branchPrefix: option }), className: `rounded-sm px-3 py-1 text-sm transition-colors ${settings.branchPrefix === option
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground'}`, children: option === 'git-username' ? 'Git Username' : option === 'custom' ? 'Custom' : 'None' }, option))) }), (settings.branchPrefix === 'custom' || settings.branchPrefix === 'git-username') && (_jsx(Input, { value: settings.branchPrefix === 'git-username'
                        ? displayedGitUsername
                        : settings.branchPrefixCustom, onChange: (e) => updateSettings({ branchPrefixCustom: e.target.value }), placeholder: settings.branchPrefix === 'git-username'
                        ? 'No git username configured'
                        : 'e.g. feature', className: "max-w-xs", readOnly: settings.branchPrefix === 'git-username' }))] }, "branch-prefix")) : null,
        matchesSettingsSearch(searchQuery, {
            title: 'Refresh Local Base Ref',
            description: 'Optionally fast-forward local main or master when creating worktrees.',
            keywords: ['main', 'master', 'origin/main', 'git diff', 'base ref', 'worktree']
        }) ? (_jsxs(SearchableSetting, { title: "Refresh Local Base Ref", description: "Optionally fast-forward local main or master when creating worktrees.", keywords: ['main', 'master', 'origin/main', 'git diff', 'base ref', 'worktree'], className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Refresh Local Base Ref" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["When enabled, Orca updates your local ", _jsx("code", { children: "main" }), " or ", _jsx("code", { children: "master" }), " before creating a worktree. This helps AI tools and diffs compare your branch against the latest base branch. Orca only does this when it is safe."] })] }), _jsx("button", { role: "switch", "aria-checked": settings.refreshLocalBaseRefOnWorktreeCreate, onClick: () => updateSettings({
                        refreshLocalBaseRefOnWorktreeCreate: !settings.refreshLocalBaseRefOnWorktreeCreate
                    }), className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${settings.refreshLocalBaseRefOnWorktreeCreate
                        ? 'bg-foreground'
                        : 'bg-muted-foreground/30'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${settings.refreshLocalBaseRefOnWorktreeCreate ? 'translate-x-4' : 'translate-x-0.5'}` }) })] }, "refresh-base-ref")) : null
    ].filter(Boolean);
    return _jsx("div", { className: "space-y-4", children: visibleSections });
}
