import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Step views for AddRepoDialog: Clone, Remote, and Setup.
 *
 * Why extracted: keeps AddRepoDialog.tsx under the 400-line oxlint limit
 * by moving the presentational JSX for each wizard step into separate components
 * while the parent retains all state and handlers.
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Folder, FolderOpen } from 'lucide-react';
import { useAppStore } from '@/store';
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RemoteFileBrowser } from './RemoteFileBrowser';
// ── Remote repo hook ────────────────────────────────────────────────
export function useRemoteRepo(fetchWorktrees, setStep, setAddedRepo, closeModal) {
    const [sshTargets, setSshTargets] = useState([]);
    const [selectedTargetId, setSelectedTargetId] = useState(null);
    const [remotePath, setRemotePath] = useState('~/');
    const [remoteError, setRemoteError] = useState(null);
    const [isAddingRemote, setIsAddingRemote] = useState(false);
    const remoteGenRef = useRef(0);
    const resetRemoteState = useCallback(() => {
        remoteGenRef.current++;
        setSshTargets([]);
        setSelectedTargetId(null);
        setRemotePath('~/');
        setRemoteError(null);
        setIsAddingRemote(false);
    }, []);
    const handleOpenRemoteStep = useCallback(async () => {
        const gen = ++remoteGenRef.current;
        setStep('remote');
        try {
            const targets = (await window.api.ssh.listTargets());
            if (gen !== remoteGenRef.current) {
                return;
            }
            const withState = await Promise.all(targets.map(async (t) => {
                const state = (await window.api.ssh.getState({
                    targetId: t.id
                }));
                return { ...t, state: state ?? undefined };
            }));
            if (gen !== remoteGenRef.current) {
                return;
            }
            setSshTargets(withState);
            const connected = withState.find((t) => t.state?.status === 'connected');
            if (connected) {
                setSelectedTargetId(connected.id);
            }
        }
        catch {
            if (gen !== remoteGenRef.current) {
                return;
            }
            setSshTargets([]);
        }
    }, [setStep]);
    const handleAddRemoteRepo = useCallback(async () => {
        if (!selectedTargetId || !remotePath.trim()) {
            return;
        }
        setIsAddingRemote(true);
        setRemoteError(null);
        try {
            const result = await window.api.repos.addRemote({
                connectionId: selectedTargetId,
                remotePath: remotePath.trim()
            });
            if ('error' in result) {
                throw new Error(result.error);
            }
            const repo = result.repo;
            const state = useAppStore.getState();
            const existingIdx = state.repos.findIndex((r) => r.id === repo.id);
            if (existingIdx === -1) {
                useAppStore.setState({ repos: [...state.repos, repo] });
            }
            else {
                const updated = [...state.repos];
                updated[existingIdx] = repo;
                useAppStore.setState({ repos: updated });
            }
            toast.success('Remote repository added', { description: repo.displayName });
            setAddedRepo(repo);
            await fetchWorktrees(repo.id);
            setStep('setup');
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('Not a valid git repository')) {
                // Why: match the local add-repo flow — show confirmation dialog so
                // users understand git features will be unavailable, rather than
                // silently adding as a folder.
                closeModal();
                useAppStore.getState().openModal('confirm-non-git-folder', {
                    folderPath: remotePath.trim(),
                    connectionId: selectedTargetId
                });
                return;
            }
            setRemoteError(message);
        }
        finally {
            setIsAddingRemote(false);
        }
    }, [selectedTargetId, remotePath, fetchWorktrees, setStep, setAddedRepo, closeModal]);
    return {
        sshTargets,
        selectedTargetId,
        remotePath,
        remoteError,
        isAddingRemote,
        setSelectedTargetId,
        setRemotePath,
        setRemoteError,
        resetRemoteState,
        handleOpenRemoteStep,
        handleAddRemoteRepo
    };
}
export function RemoteStep({ sshTargets, selectedTargetId, remotePath, remoteError, isAddingRemote, onSelectTarget, onRemotePathChange, onAdd }) {
    const [browsing, setBrowsing] = useState(false);
    if (browsing && selectedTargetId) {
        return (_jsxs(_Fragment, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Browse remote filesystem" }), _jsx(DialogDescription, { children: "Navigate to a directory and click Select to choose it." })] }), _jsx(RemoteFileBrowser, { targetId: selectedTargetId, initialPath: remotePath || '~', onSelect: (path) => {
                        onRemotePathChange(path);
                        setBrowsing(false);
                    }, onCancel: () => setBrowsing(false) })] }));
    }
    return (_jsxs(_Fragment, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Open remote repo" }), _jsx(DialogDescription, { children: "Choose a connected SSH target and enter the path to a Git repository." })] }), _jsxs("div", { className: "space-y-3 pt-1", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "SSH target" }), sshTargets.length === 0 ? (_jsx("p", { className: "text-xs text-muted-foreground py-2", children: "No SSH targets configured. Add one in Settings first." })) : (_jsx("div", { className: "space-y-1.5", children: sshTargets.map((target) => {
                                    const isConnected = target.state?.status === 'connected';
                                    const isSelected = selectedTargetId === target.id;
                                    return (_jsxs("button", { className: `w-full flex items-center gap-2 px-3 py-2 rounded-md border text-xs transition-colors cursor-pointer ${isSelected
                                            ? 'border-foreground/30 bg-accent'
                                            : 'border-border hover:bg-accent/50'} ${!isConnected ? 'opacity-50' : ''}`, onClick: () => {
                                            if (isConnected) {
                                                onSelectTarget(target.id);
                                            }
                                        }, disabled: !isConnected, children: [_jsx("span", { className: `size-2 rounded-full shrink-0 ${isConnected ? 'bg-green-500' : 'bg-muted-foreground/30'}` }), _jsx("span", { className: "font-medium truncate", children: target.label || `${target.username}@${target.host}` }), !isConnected && (_jsx("span", { className: "text-muted-foreground ml-auto", children: "Not connected" }))] }, target.id));
                                }) }))] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "Remote path" }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { value: remotePath, onChange: (e) => onRemotePathChange(e.target.value), placeholder: "/home/user/project", className: "h-8 text-xs flex-1", disabled: isAddingRemote }), _jsx(Button, { variant: "outline", size: "sm", className: "h-8 px-2 shrink-0", onClick: () => setBrowsing(true), disabled: !selectedTargetId || isAddingRemote, children: _jsx(FolderOpen, { className: "size-3.5" }) })] })] }), remoteError && _jsx("p", { className: "text-[11px] text-destructive", children: remoteError }), _jsx(Button, { onClick: onAdd, disabled: !selectedTargetId || !remotePath.trim() || isAddingRemote, className: "w-full", children: isAddingRemote ? 'Adding...' : 'Add remote repo' })] })] }));
}
export function CloneStep({ cloneUrl, cloneDestination, cloneError, cloneProgress, isCloning, onUrlChange, onDestChange, onPickDestination, onClone }) {
    return (_jsxs(_Fragment, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Clone from URL" }), _jsx(DialogDescription, { children: "Enter the Git URL and choose where to clone it." })] }), _jsxs("div", { className: "space-y-3 pt-1", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "Git URL" }), _jsx(Input, { value: cloneUrl, onChange: (e) => onUrlChange(e.target.value), placeholder: "https://github.com/user/repo.git", className: "h-8 text-xs", disabled: isCloning, autoFocus: true })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground", children: "Clone location" }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { value: cloneDestination, onChange: (e) => onDestChange(e.target.value), placeholder: "/path/to/destination", className: "h-8 text-xs flex-1", disabled: isCloning }), _jsx(Button, { variant: "outline", size: "sm", className: "h-8 px-2 shrink-0", onClick: onPickDestination, disabled: isCloning, children: _jsx(Folder, { className: "size-3.5" }) })] })] }), cloneError && _jsx("p", { className: "text-[11px] text-destructive", children: cloneError }), _jsx(Button, { onClick: onClone, disabled: !cloneUrl.trim() || !cloneDestination.trim() || isCloning, className: "w-full", children: isCloning ? 'Cloning...' : 'Clone' }), isCloning && cloneProgress && (_jsxs("div", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between text-[11px] text-muted-foreground", children: [_jsx("span", { children: cloneProgress.phase }), _jsxs("span", { children: [cloneProgress.percent, "%"] })] }), _jsx("div", { className: "h-1.5 w-full rounded-full bg-secondary overflow-hidden", children: _jsx("div", { className: "h-full rounded-full bg-foreground transition-[width] duration-300 ease-out", style: { width: `${cloneProgress.percent}%` } }) })] }))] })] }));
}
