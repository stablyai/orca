import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, FolderPlus, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '@/store';
import { isGitRepoKind } from '../../../../shared/repo-kind';
import { searchRepos } from '@/lib/repo-search';
import { cn } from '@/lib/utils';
import RepoDotLabel from './RepoDotLabel';
export default function RepoCombobox({ repos, value, onValueChange, placeholder = 'Select repo...', triggerClassName }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // Why: controlled cmdk selection so hovering the footer (which lives outside
    // the cmdk tree) can clear the list's highlighted item — otherwise cmdk keeps
    // the last-hovered repo visually selected while the mouse is on the footer.
    const [commandValue, setCommandValue] = useState('');
    const addRepo = useAppStore((s) => s.addRepo);
    const fetchWorktrees = useAppStore((s) => s.fetchWorktrees);
    const [isAdding, setIsAdding] = useState(false);
    const selectedRepo = useMemo(() => repos.find((repo) => repo.id === value) ?? null, [repos, value]);
    const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query]);
    const handleOpenChange = useCallback((nextOpen) => {
        setOpen(nextOpen);
        // Why: the create-worktree dialog delays its own field reset until after
        // close animation, so the repo picker must clear its local filter here or a
        // stale query can reopen to an apparently missing repo list.
        if (!nextOpen) {
            setQuery('');
        }
    }, []);
    const handleSelect = useCallback((repoId) => {
        onValueChange(repoId);
        setOpen(false);
        setQuery('');
    }, [onValueChange]);
    const handleAddFolder = useCallback(async () => {
        if (isAdding) {
            return;
        }
        setIsAdding(true);
        try {
            const repo = await addRepo();
            if (repo) {
                if (isGitRepoKind(repo)) {
                    await fetchWorktrees(repo.id);
                }
                onValueChange(repo.id);
                setOpen(false);
                setQuery('');
            }
        }
        finally {
            setIsAdding(false);
        }
    }, [addRepo, fetchWorktrees, isAdding, onValueChange]);
    return (_jsxs(Popover, { open: open, onOpenChange: handleOpenChange, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { type: "button", variant: "outline", role: "combobox", "aria-expanded": open, className: cn('h-8 w-full justify-between px-3 text-xs font-normal', triggerClassName), "data-repo-combobox-root": "true", children: [selectedRepo ? (_jsxs("span", { className: "inline-flex min-w-0 items-center gap-1.5", children: [_jsx(RepoDotLabel, { name: selectedRepo.displayName, color: selectedRepo.badgeColor, dotClassName: "size-1.5" }), selectedRepo.connectionId && (_jsxs("span", { className: "shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground", children: [_jsx(Globe, { className: "size-2.5" }), "SSH"] }))] })) : (_jsx("span", { className: "text-muted-foreground", children: placeholder })), _jsx(ChevronsUpDown, { className: "size-3.5 opacity-50" })] }) }), _jsx(PopoverContent, { align: "start", className: "w-[var(--radix-popover-trigger-width)] p-0", "data-repo-combobox-root": "true", children: _jsxs(Command, { shouldFilter: false, value: commandValue, onValueChange: setCommandValue, children: [_jsx(CommandInput, { autoFocus: true, placeholder: "Search repos/folders...", value: query, onValueChange: setQuery }), _jsxs(CommandList, { children: [_jsx(CommandEmpty, { children: "No repos/folders match your search." }), filteredRepos.map((repo) => (_jsxs(CommandItem, { value: repo.id, onSelect: () => handleSelect(repo.id), className: "items-center gap-2 px-3 py-2", children: [_jsx(Check, { className: cn('size-4 text-foreground', value === repo.id ? 'opacity-100' : 'opacity-0') }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx(RepoDotLabel, { name: repo.displayName, color: repo.badgeColor, className: "max-w-full" }), repo.connectionId && (_jsxs("span", { className: "shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground", children: [_jsx(Globe, { className: "size-2.5" }), "SSH"] }))] }), _jsx("p", { className: "mt-0.5 truncate text-[11px] text-muted-foreground", children: repo.path })] })] }, repo.id)))] }), _jsx("div", { className: "border-t border-border", children: _jsxs("button", { type: "button", disabled: isAdding, onClick: handleAddFolder, onMouseDown: (event) => event.preventDefault(), onMouseEnter: () => setCommandValue(''), className: "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60", children: [_jsx(FolderPlus, { className: "size-3.5 text-muted-foreground" }), _jsx("span", { children: isAdding ? 'Adding folder/repo…' : 'Add folder/repo' })] }) })] }) })] }));
}
