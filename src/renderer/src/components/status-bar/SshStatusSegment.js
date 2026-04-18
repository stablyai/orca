import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useState } from 'react';
import { Loader2, MonitorSmartphone, Wifi, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAppStore } from '../../store';
import { STATUS_LABELS, statusColor } from '../settings/SshTargetCard';
function isConnecting(status) {
    return ['connecting', 'deploying-relay', 'reconnecting'].includes(status);
}
function isReconnectable(status) {
    return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status);
}
function overallStatus(statuses) {
    if (statuses.length === 0) {
        return 'disconnected';
    }
    if (statuses.every((s) => s === 'connected')) {
        return 'connected';
    }
    if (statuses.some((s) => isConnecting(s))) {
        return 'connecting';
    }
    if (statuses.some((s) => s === 'connected')) {
        return 'partial';
    }
    return 'disconnected';
}
function overallDotColor(status) {
    switch (status) {
        case 'connected':
            return 'bg-emerald-500';
        case 'partial':
            return 'bg-yellow-500';
        case 'connecting':
            return 'bg-yellow-500';
        default:
            return 'bg-muted-foreground/40';
    }
}
function overallLabel(status) {
    switch (status) {
        case 'connected':
            return 'Connected';
        case 'partial':
            return 'Partial';
        case 'connecting':
            return 'Connecting…';
        default:
            return 'Disconnected';
    }
}
function TargetRow({ targetId, label, status }) {
    const [busy, setBusy] = useState(false);
    const handleConnect = useCallback(async () => {
        setBusy(true);
        try {
            await window.api.ssh.connect({ targetId });
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Connection failed');
        }
        finally {
            setBusy(false);
        }
    }, [targetId]);
    const handleDisconnect = useCallback(async () => {
        setBusy(true);
        try {
            await window.api.ssh.disconnect({ targetId });
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Disconnect failed');
        }
        finally {
            setBusy(false);
        }
    }, [targetId]);
    return (_jsxs("div", { className: "flex items-center gap-2.5 px-2 py-1.5", children: [_jsx("span", { className: `size-1.5 shrink-0 rounded-full ${statusColor(status)}` }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-[12px] font-medium", children: label }), _jsx("div", { className: "text-[10px] text-muted-foreground", children: STATUS_LABELS[status] })] }), busy ? (_jsx(Loader2, { className: "size-3 shrink-0 animate-spin text-muted-foreground" })) : isReconnectable(status) ? (_jsx("button", { type: "button", onClick: () => void handleConnect(), className: "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent/70", children: "Connect" })) : status === 'connected' ? (_jsx("button", { type: "button", onClick: () => void handleDisconnect(), className: "shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/70 hover:text-foreground", children: "Disconnect" })) : null] }));
}
export function SshStatusSegment({ compact, iconOnly }) {
    const sshConnectionStates = useAppStore((s) => s.sshConnectionStates);
    const sshTargetLabels = useAppStore((s) => s.sshTargetLabels);
    const setActiveView = useAppStore((s) => s.setActiveView);
    const openSettingsTarget = useAppStore((s) => s.openSettingsTarget);
    const targets = Array.from(sshTargetLabels.entries()).map(([id, label]) => {
        const state = sshConnectionStates.get(id);
        return { id, label, status: (state?.status ?? 'disconnected') };
    });
    if (targets.length === 0) {
        return null;
    }
    const statuses = targets.map((t) => t.status);
    const overall = overallStatus(statuses);
    const anyConnecting = overall === 'connecting';
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { type: "button", className: "inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70", "aria-label": "SSH connection status", children: iconOnly ? (_jsxs("span", { className: "inline-flex items-center gap-1", children: [_jsx("span", { className: `inline-block size-2 rounded-full ${overallDotColor(overall)}` }), anyConnecting ? (_jsx(Loader2, { className: "size-3 animate-spin text-muted-foreground" })) : (_jsx(MonitorSmartphone, { className: "size-3 text-muted-foreground" }))] })) : (_jsxs("span", { className: "inline-flex items-center gap-1.5", children: [anyConnecting ? (_jsx(Loader2, { className: "size-3 animate-spin text-yellow-500" })) : overall === 'connected' ? (_jsx(Wifi, { className: "size-3 text-emerald-500" })) : overall === 'partial' ? (_jsx(Wifi, { className: "size-3 text-muted-foreground" })) : (_jsx(WifiOff, { className: "size-3 text-muted-foreground" })), !compact && (_jsxs("span", { className: "text-[11px]", children: ["SSH ", _jsx("span", { className: "text-muted-foreground", children: overallLabel(overall) })] })), _jsx("span", { className: `inline-block size-1.5 rounded-full ${overallDotColor(overall)}` })] })) }) }), _jsxs(DropdownMenuContent, { side: "top", align: "start", sideOffset: 8, className: "w-[220px]", children: [_jsx("div", { className: "px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground", children: "SSH Connections" }), targets.map((t) => (_jsx(TargetRow, { targetId: t.id, label: t.label, status: t.status }, t.id))), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { onSelect: () => {
                            openSettingsTarget({ pane: 'general', repoId: null, sectionId: 'ssh' });
                            setActiveView('settings');
                        }, children: "Manage SSH\u2026" })] })] }));
}
