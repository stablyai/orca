import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Upload } from 'lucide-react';
import { useAppStore } from '@/store';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { SshTargetCard } from './SshTargetCard';
import { SshTargetForm, EMPTY_FORM } from './SshTargetForm';
export const SSH_PANE_SEARCH_ENTRIES = [
    {
        title: 'SSH Connections',
        description: 'Manage remote SSH targets.',
        keywords: ['ssh', 'remote', 'server', 'connection', 'host']
    },
    {
        title: 'Add SSH Target',
        description: 'Add a new remote SSH target.',
        keywords: ['ssh', 'add', 'new', 'target', 'host', 'server']
    },
    {
        title: 'Import from SSH Config',
        description: 'Import hosts from ~/.ssh/config.',
        keywords: ['ssh', 'import', 'config', 'hosts']
    },
    {
        title: 'Test Connection',
        description: 'Test connectivity to an SSH target.',
        keywords: ['ssh', 'test', 'connection', 'ping']
    }
];
export function SshPane(_props) {
    const [targets, setTargets] = useState([]);
    // Why: connection states are already hydrated and kept up-to-date by the
    // global store (via useIpcEvents.ts). Reading from the store avoids
    // duplicating the onStateChanged listener and per-target getState IPC calls.
    const sshConnectionStates = useAppStore((s) => s.sshConnectionStates);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [testingIds, setTestingIds] = useState(new Set());
    const [pendingRemove, setPendingRemove] = useState(null);
    const setSshTargetLabels = useAppStore((s) => s.setSshTargetLabels);
    const loadTargets = useCallback(async (opts) => {
        try {
            const result = (await window.api.ssh.listTargets());
            if (opts?.signal?.aborted) {
                return;
            }
            setTargets(result);
            const labels = new Map();
            for (const t of result) {
                labels.set(t.id, t.label);
            }
            setSshTargetLabels(labels);
        }
        catch {
            if (!opts?.signal?.aborted) {
                toast.error('Failed to load SSH targets');
            }
        }
    }, [setSshTargetLabels]);
    useEffect(() => {
        const abortController = new AbortController();
        void loadTargets({ signal: abortController.signal });
        return () => abortController.abort();
    }, [loadTargets]);
    const handleSave = async () => {
        if (!form.host.trim() || !form.username.trim()) {
            toast.error('Host and username are required');
            return;
        }
        const port = parseInt(form.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            toast.error('Port must be between 1 and 65535');
            return;
        }
        const target = {
            label: form.label.trim() || `${form.username}@${form.host}`,
            configHost: form.configHost.trim() || form.host.trim(),
            host: form.host.trim(),
            port,
            username: form.username.trim(),
            ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
            ...(form.proxyCommand.trim() ? { proxyCommand: form.proxyCommand.trim() } : {}),
            ...(form.jumpHost.trim() ? { jumpHost: form.jumpHost.trim() } : {})
        };
        try {
            if (editingId) {
                await window.api.ssh.updateTarget({ id: editingId, updates: target });
                toast.success('Target updated');
            }
            else {
                await window.api.ssh.addTarget({ target });
                toast.success('Target added');
            }
            setShowForm(false);
            setEditingId(null);
            setForm(EMPTY_FORM);
            await loadTargets();
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save target');
        }
    };
    const handleRemove = async (id) => {
        try {
            // Why: disconnect any non-disconnected connection, including transitional
            // states (connecting, reconnecting, deploying-relay). Leaving these alive
            // would orphan SSH connections with providers registered for a removed target.
            const state = sshConnectionStates.get(id);
            if (state && state.status !== 'disconnected') {
                await window.api.ssh.disconnect({ targetId: id });
            }
            await window.api.ssh.removeTarget({ id });
            toast.success('Target removed');
            await loadTargets();
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to remove target');
        }
    };
    const handleEdit = (target) => {
        setEditingId(target.id);
        setForm({
            label: target.label,
            configHost: target.configHost ?? target.host,
            host: target.host,
            port: String(target.port),
            username: target.username,
            identityFile: target.identityFile ?? '',
            proxyCommand: target.proxyCommand ?? '',
            jumpHost: target.jumpHost ?? ''
        });
        setShowForm(true);
    };
    const handleConnect = async (targetId) => {
        try {
            await window.api.ssh.connect({ targetId });
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Connection failed');
        }
    };
    const handleDisconnect = async (targetId) => {
        try {
            await window.api.ssh.disconnect({ targetId });
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Disconnect failed');
        }
    };
    const handleTest = async (targetId) => {
        setTestingIds((prev) => new Set(prev).add(targetId));
        try {
            const result = await window.api.ssh.testConnection({ targetId });
            if (result.success) {
                toast.success('Connection successful');
            }
            else {
                toast.error(result.error ?? 'Connection test failed');
            }
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Test failed');
        }
        finally {
            setTestingIds((prev) => {
                const next = new Set(prev);
                next.delete(targetId);
                return next;
            });
        }
    };
    const handleImport = async () => {
        try {
            const imported = (await window.api.ssh.importConfig());
            if (imported.length === 0) {
                toast('No new hosts found in ~/.ssh/config');
            }
            else {
                toast.success(`Imported ${imported.length} host${imported.length > 1 ? 's' : ''}`);
            }
            await loadTargets();
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Import failed');
        }
    };
    const cancelForm = () => {
        setShowForm(false);
        setEditingId(null);
        setForm(EMPTY_FORM);
    };
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx("p", { className: "text-sm font-medium", children: "Targets" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Add a remote host to connect to it in Orca." })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1.5", children: [_jsxs(Button, { variant: "outline", size: "xs", onClick: () => void handleImport(), className: "gap-1.5", children: [_jsx(Upload, { className: "size-3" }), "Import"] }), !showForm ? (_jsxs(Button, { variant: "outline", size: "xs", onClick: () => {
                                    setEditingId(null);
                                    setForm(EMPTY_FORM);
                                    setShowForm(true);
                                }, className: "gap-1.5", children: [_jsx(Plus, { className: "size-3" }), "Add Target"] })) : null] })] }), targets.length === 0 && !showForm ? (_jsx("div", { className: "flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground", children: "No SSH targets configured." })) : (_jsx("div", { className: "space-y-2", children: targets.map((target) => (_jsx(SshTargetCard, { target: target, state: sshConnectionStates.get(target.id), testing: testingIds.has(target.id), onConnect: (id) => void handleConnect(id), onDisconnect: (id) => void handleDisconnect(id), onTest: (id) => void handleTest(id), onEdit: handleEdit, onRemove: (id) => setPendingRemove({ id, label: target.label }) }, target.id))) })), showForm ? (_jsx(SshTargetForm, { editingId: editingId, form: form, onFormChange: setForm, onSave: () => void handleSave(), onCancel: cancelForm })) : null, _jsx(Dialog, { open: !!pendingRemove, onOpenChange: (open) => {
                    if (!open) {
                        setPendingRemove(null);
                    }
                }, children: _jsxs(DialogContent, { className: "max-w-sm sm:max-w-sm", showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Remove SSH Target" }), _jsx(DialogDescription, { className: "text-xs", children: "This will remove the target and disconnect any active sessions." })] }), pendingRemove ? (_jsx("div", { className: "rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs", children: _jsx("div", { className: "break-all text-muted-foreground", children: pendingRemove.label }) })) : null, _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => setPendingRemove(null), children: "Cancel" }), _jsx(Button, { variant: "destructive", onClick: () => {
                                        if (pendingRemove) {
                                            void handleRemove(pendingRemove.id);
                                            setPendingRemove(null);
                                        }
                                    }, children: "Remove" })] })] }) })] }));
}
