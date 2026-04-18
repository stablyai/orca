import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Loader2, MonitorSmartphone, Pencil, Server, Trash2, Wifi, WifiOff } from 'lucide-react';
import { Button } from '../ui/button';
// ── Shared status helpers ────────────────────────────────────────────
export const STATUS_LABELS = {
    disconnected: 'Disconnected',
    connecting: 'Connecting\u2026',
    'auth-failed': 'Auth failed',
    'deploying-relay': 'Deploying relay\u2026',
    connected: 'Connected',
    reconnecting: 'Reconnecting\u2026',
    'reconnection-failed': 'Reconnection failed',
    error: 'Error'
};
export function statusColor(status) {
    switch (status) {
        case 'connected':
            return 'bg-emerald-500';
        case 'connecting':
        case 'deploying-relay':
        case 'reconnecting':
            return 'bg-yellow-500';
        case 'auth-failed':
        case 'reconnection-failed':
        case 'error':
            return 'bg-red-500';
        default:
            return 'bg-muted-foreground/40';
    }
}
export function isConnecting(status) {
    return ['connecting', 'deploying-relay', 'reconnecting'].includes(status);
}
export function SshTargetCard({ target, state, testing, onConnect, onDisconnect, onTest, onEdit, onRemove }) {
    const status = state?.status ?? 'disconnected';
    const [actionInFlight, setActionInFlight] = useState(null);
    const handleConnect = () => {
        if (actionInFlight) {
            return;
        }
        setActionInFlight('connect');
        Promise.resolve(onConnect(target.id)).finally(() => setActionInFlight(null));
    };
    const handleDisconnect = () => {
        if (actionInFlight) {
            return;
        }
        setActionInFlight('disconnect');
        Promise.resolve(onDisconnect(target.id)).finally(() => setActionInFlight(null));
    };
    return (_jsxs("div", { className: "flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-4 py-3", children: [_jsx(Server, { className: "size-4 shrink-0 text-muted-foreground" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: target.label }), _jsx("span", { className: `size-2 shrink-0 rounded-full ${statusColor(status)}` }), _jsx("span", { className: "text-[11px] text-muted-foreground", children: STATUS_LABELS[status] })] }), _jsxs("p", { className: "truncate text-xs text-muted-foreground", children: [target.username, "@", target.host, ":", target.port, target.identityFile ? ` \u2022 ${target.identityFile}` : ''] }), state?.error ? (_jsx("p", { className: "mt-0.5 truncate text-xs text-red-400", children: state.error })) : null] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1", children: [status === 'connected' ? (_jsxs(Button, { variant: "ghost", size: "xs", onClick: handleDisconnect, className: "gap-1.5", disabled: actionInFlight !== null, children: [_jsx(WifiOff, { className: "size-3" }), "Disconnect"] })) : isConnecting(status) ? (_jsxs(Button, { variant: "ghost", size: "xs", disabled: true, className: "gap-1.5", children: [_jsx(Loader2, { className: "size-3 animate-spin" }), "Connecting"] })) : (_jsxs(_Fragment, { children: [_jsxs(Button, { variant: "ghost", size: "xs", onClick: handleConnect, className: "gap-1.5", disabled: actionInFlight !== null, children: [actionInFlight === 'connect' ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(Wifi, { className: "size-3" })), "Connect"] }), _jsxs(Button, { variant: "ghost", size: "xs", onClick: () => onTest(target.id), disabled: testing, className: "gap-1.5", children: [testing ? (_jsx(Loader2, { className: "size-3 animate-spin" })) : (_jsx(MonitorSmartphone, { className: "size-3" })), "Test"] })] })), _jsx(Button, { variant: "ghost", size: "icon", onClick: () => onEdit(target), className: "size-7", "aria-label": "Edit target", children: _jsx(Pencil, { className: "size-3" }) }), _jsx(Button, { variant: "ghost", size: "icon", onClick: () => onRemove(target.id), className: "size-7 text-muted-foreground hover:text-red-400", "aria-label": "Remove target", children: _jsx(Trash2, { className: "size-3" }) })] })] }));
}
