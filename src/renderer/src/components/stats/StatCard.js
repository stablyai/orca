import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StatCard({ label, value, icon }) {
    return (_jsxs("div", { className: "flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-4 py-3", children: [_jsx("div", { className: "flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground", children: icon }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-lg font-semibold leading-tight text-foreground", children: value }), _jsx("p", { className: "text-xs text-muted-foreground", children: label })] })] }));
}
