import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback } from 'react';
import { Search, X, Activity, FolderTree, FolderPlus } from 'lucide-react';
import { useAppStore } from '@/store';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import RepoDotLabel from '@/components/repo/RepoDotLabel';
const SearchBar = React.memo(function SearchBar() {
    const searchQuery = useAppStore((s) => s.searchQuery);
    const setSearchQuery = useAppStore((s) => s.setSearchQuery);
    const showActiveOnly = useAppStore((s) => s.showActiveOnly);
    const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly);
    const filterRepoIds = useAppStore((s) => s.filterRepoIds);
    const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds);
    const repos = useAppStore((s) => s.repos);
    const addRepo = useAppStore((s) => s.addRepo);
    const selectedRepos = repos.filter((r) => filterRepoIds.includes(r.id));
    const handleToggleRepo = useCallback((repoId) => {
        setFilterRepoIds(filterRepoIds.includes(repoId)
            ? filterRepoIds.filter((id) => id !== repoId)
            : [...filterRepoIds, repoId]);
    }, [filterRepoIds, setFilterRepoIds]);
    const repoTriggerLabel = selectedRepos.length === 0 ? (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx(FolderTree, { className: "size-3 text-muted-foreground" }), _jsx("span", { children: "All" })] })) : selectedRepos.length === 1 ? (_jsx(RepoDotLabel, { name: selectedRepos[0].displayName, color: selectedRepos[0].badgeColor, dotClassName: "size-1" })) : (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx(FolderTree, { className: "size-3 text-muted-foreground" }), _jsxs("span", { children: [selectedRepos.length, " repos"] })] }));
    const handleClear = useCallback(() => setSearchQuery(''), [setSearchQuery]);
    const handleToggleActive = useCallback(() => setShowActiveOnly(!showActiveOnly), [showActiveOnly, setShowActiveOnly]);
    return (_jsx("div", { className: "px-2 pb-4", children: _jsxs("div", { className: "relative flex items-center", children: [_jsx(Search, { className: "absolute left-2 size-3.5 text-muted-foreground pointer-events-none" }), _jsx(Input, { value: searchQuery, onChange: (e) => setSearchQuery(e.target.value), placeholder: "Search...", className: "h-7 pl-7 pr-20 text-[11px] border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30" }), _jsxs("div", { className: "absolute right-1 flex items-center gap-0.5", children: [searchQuery && (_jsx(Button, { variant: "ghost", size: "icon-xs", onClick: handleClear, className: "size-5", children: _jsx(X, { className: "size-3" }) })), _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs(Button, { variant: "ghost", size: "icon-xs", onClick: handleToggleActive, className: cn('relative size-5', showActiveOnly && 'bg-accent text-accent-foreground'), children: [_jsx(Activity, { className: "size-3" }), showActiveOnly ? (_jsx("span", { className: "absolute top-0.5 right-0.5 size-1.5 rounded-full bg-green-500 ring-1 ring-background" })) : null] }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 4, children: showActiveOnly ? 'Show all' : 'Active only' })] }), repos.length > 1 && (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "sm", type: "button", "aria-label": "Filter repositories", className: "h-5 w-auto gap-1 border-none bg-transparent px-1 text-[10px] font-normal shadow-none hover:bg-accent/60 focus-visible:ring-0", children: repoTriggerLabel }) }), _jsxs(DropdownMenuContent, { align: "end", children: [_jsx(DropdownMenuItem, { onSelect: () => {
                                                setFilterRepoIds([]);
                                            }, children: "All repos" }), repos.map((r) => (_jsx(DropdownMenuCheckboxItem, { checked: filterRepoIds.includes(r.id), onCheckedChange: () => handleToggleRepo(r.id), onSelect: (event) => event.preventDefault(), children: _jsx(RepoDotLabel, { name: r.displayName, color: r.badgeColor }) }, r.id))), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { inset: true, onSelect: () => {
                                                addRepo();
                                            }, children: [_jsx(FolderPlus, { className: "absolute left-2.5 size-3.5 text-muted-foreground" }), "Add repo"] })] })] }))] })] }) }));
});
export default SearchBar;
