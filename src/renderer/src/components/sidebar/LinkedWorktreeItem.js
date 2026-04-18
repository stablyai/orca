import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function LinkedWorktreeItem({ worktree, onOpen }) {
    const branchLabel = worktree.branch.replace(/^refs\/heads\//, '');
    return (_jsxs("button", { className: "group flex items-center justify-between gap-3 w-full rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-accent cursor-pointer", onClick: onOpen, children: [_jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-sm font-medium text-foreground truncate", children: worktree.displayName }), branchLabel !== worktree.displayName && (_jsx("p", { className: "text-xs text-muted-foreground truncate mt-0.5", children: branchLabel }))] }), _jsx("span", { className: "shrink-0 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors", children: "Open" })] }));
}
