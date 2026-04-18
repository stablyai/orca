import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Globe, Loader2, WifiOff } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { statusColor } from '@/components/settings/SshTargetCard';
const STATUS_MESSAGES = {
    disconnected: 'This remote repository is not connected.',
    reconnecting: 'Reconnecting to the remote host...',
    'reconnection-failed': 'Reconnection to the remote host failed.',
    error: 'The connection to the remote host encountered an error.',
    'auth-failed': 'Authentication to the remote host failed.'
};
function isReconnectable(status) {
    return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status);
}
export function SshDisconnectedDialog({ open, onOpenChange, targetId, targetLabel, status }) {
    const [connecting, setConnecting] = useState(false);
    const handleReconnect = useCallback(async () => {
        setConnecting(true);
        try {
            await window.api.ssh.connect({ targetId });
            onOpenChange(false);
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Reconnection failed');
        }
        finally {
            setConnecting(false);
        }
    }, [targetId, onOpenChange]);
    const isConnecting = connecting ||
        status === 'connecting' ||
        status === 'deploying-relay' ||
        status === 'reconnecting';
    const message = isConnecting
        ? 'Reconnecting to the remote host...'
        : (STATUS_MESSAGES[status] ?? 'This remote repository is not connected.');
    const showReconnect = isReconnectable(status);
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "sm:max-w-sm gap-3 p-5", showCloseButton: false, children: [_jsxs(DialogHeader, { className: "gap-1", children: [_jsxs(DialogTitle, { className: "flex items-center gap-2 text-sm font-semibold", children: [isConnecting ? (_jsx(Loader2, { className: "size-4 text-yellow-500 animate-spin" })) : (_jsx(WifiOff, { className: "size-4 text-muted-foreground" })), isConnecting ? 'Reconnecting...' : 'SSH Disconnected'] }), _jsx(DialogDescription, { className: "text-xs", children: message })] }), _jsxs("div", { className: "flex items-center gap-2.5 rounded-md border border-border/50 bg-card/40 px-3 py-2", children: [_jsx(Globe, { className: "size-3.5 shrink-0 text-muted-foreground" }), _jsx("div", { className: "min-w-0 flex-1", children: _jsx("span", { className: "text-xs font-medium", children: targetLabel }) }), isConnecting ? (_jsx(Loader2, { className: "size-3.5 shrink-0 text-yellow-500 animate-spin" })) : (_jsx("span", { className: `size-1.5 shrink-0 rounded-full ${statusColor(status)}` }))] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", size: "sm", onClick: () => onOpenChange(false), disabled: isConnecting, children: "Dismiss" }), showReconnect && (_jsx(Button, { size: "sm", onClick: () => void handleReconnect(), disabled: isConnecting, children: isConnecting ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "size-3.5 animate-spin" }), "Connecting..."] })) : ('Reconnect') }))] })] }) }));
}
