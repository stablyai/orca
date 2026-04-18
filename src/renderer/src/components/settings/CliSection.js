import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Copy, FolderOpen, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Label } from '../ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
const ORCA_SKILL_INSTALL_COMMAND = 'npx skills add https://github.com/stablyai/orca --skill orca-cli';
function getRevealLabel(platform) {
    if (platform === 'darwin') {
        return 'Show in Finder';
    }
    if (platform === 'win32') {
        return 'Show in Explorer';
    }
    return 'Show in File Manager';
}
function getInstallDescription(platform) {
    if (platform === 'darwin') {
        return 'Register `orca` in /usr/local/bin.';
    }
    if (platform === 'linux') {
        return 'Register `orca` in ~/.local/bin.';
    }
    if (platform === 'win32') {
        return 'Register `orca` in your user PATH.';
    }
    return 'CLI registration is not yet available on this platform.';
}
export function CliSection({ currentPlatform }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busyAction, setBusyAction] = useState(null);
    const refreshStatus = async () => {
        setLoading(true);
        try {
            setStatus(await window.api.cli.getInstallStatus());
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to load CLI status.');
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void refreshStatus();
    }, []);
    const isEnabled = status?.state === 'installed';
    const isSupported = status?.supported ?? false;
    const revealLabel = getRevealLabel(currentPlatform);
    const canRevealCommandPath = status?.commandPath != null && ['installed', 'stale', 'conflict'].includes(status.state);
    const handleInstall = async () => {
        setBusyAction('install');
        try {
            const next = await window.api.cli.install();
            setStatus(next);
            setDialogOpen(false);
            toast.success('Registered `orca` in PATH.');
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to register `orca` in PATH.');
        }
        finally {
            setBusyAction(null);
        }
    };
    const handleRemove = async () => {
        setBusyAction('remove');
        try {
            const next = await window.api.cli.remove();
            setStatus(next);
            setDialogOpen(false);
            toast.success('Removed `orca` from PATH.');
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to remove `orca` from PATH.');
        }
        finally {
            setBusyAction(null);
        }
    };
    const handleCopySkillInstallCommand = async () => {
        try {
            await window.api.ui.writeClipboardText(ORCA_SKILL_INSTALL_COMMAND);
            toast.success('Copied Orca skill install command.');
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to copy install command.');
        }
    };
    return (_jsxs("section", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Orca CLI" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Use Orca from your terminal to open the app, manage worktrees, and interact with Orca terminals." })] }), _jsxs("div", { className: "space-y-3 rounded-xl border border-border/60 bg-card/50 p-4", children: [_jsxs("div", { className: "flex items-center justify-between gap-4", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Shell command" }), _jsx("p", { className: "text-xs text-muted-foreground", children: loading
                                            ? 'Checking CLI registration…'
                                            : (status?.detail ?? getInstallDescription(currentPlatform)) })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(TooltipProvider, { delayDuration: 250, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", onClick: () => void refreshStatus(), disabled: loading || busyAction !== null, "aria-label": "Refresh CLI status", children: _jsx(RefreshCw, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Refresh" })] }) }), _jsx("button", { role: "switch", "aria-checked": isEnabled, disabled: loading || !isSupported || busyAction !== null, onClick: () => setDialogOpen(true), className: `relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${isEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'} ${loading || !isSupported || busyAction !== null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}` }) })] })] }), status?.commandPath ? (_jsxs("p", { className: "text-xs text-muted-foreground", children: ["Command path:", ' ', _jsx("code", { className: "rounded bg-muted px-1 py-0.5 text-[11px]", children: status.commandPath })] })) : null, status?.state === 'stale' && status.currentTarget ? (_jsxs("p", { className: "text-xs text-amber-600 dark:text-amber-400", children: ["Existing launcher target: ", _jsx("code", { children: status.currentTarget })] })) : null, status?.state === 'installed' && !status.pathConfigured && status.pathDirectory ? (_jsxs("p", { className: "text-xs text-amber-600 dark:text-amber-400", children: [status.pathDirectory, " is not currently visible on PATH for this shell."] })) : null, !loading && !isSupported && status?.detail ? (_jsx("p", { className: "text-xs text-muted-foreground", children: status.detail })) : null, _jsx("div", { className: "flex items-center gap-2", children: status?.commandPath ? (_jsxs(Button, { variant: "ghost", size: "sm", onClick: () => void window.api.shell.openPath(status.commandPath), disabled: loading || !canRevealCommandPath, className: "gap-2", children: [_jsx(FolderOpen, { className: "size-3.5" }), revealLabel] })) : null }), _jsxs("div", { className: "border-t border-border/60 pt-3", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsx(Label, { children: "Agent skill" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Install the Orca skill so agents know to use the", ' ', _jsx("code", { className: "rounded bg-muted px-1 py-0.5 text-[11px]", children: "orca" }), " CLI."] })] }), _jsxs("div", { className: "mt-3 space-y-1", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "Install command" }), _jsxs("div", { className: "inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2", children: [_jsx("code", { className: "overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground", children: ORCA_SKILL_INSTALL_COMMAND }), _jsx(TooltipProvider, { delayDuration: 250, children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", onClick: () => void handleCopySkillInstallCommand(), "aria-label": "Copy skill install command", children: _jsx(Copy, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 6, children: "Copy" })] }) })] })] })] })] }), _jsx(Dialog, { open: dialogOpen, onOpenChange: setDialogOpen, children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: isEnabled ? 'Remove `orca` from PATH?' : 'Register `orca` in PATH?' }), _jsx(DialogDescription, { children: isEnabled
                                        ? 'This removes the shell command symlink. Orca itself remains installed.'
                                        : `Orca will register ${status?.commandPath ?? '`orca`'} so the command works from your terminal.` })] }), status?.commandPath ? (_jsxs("p", { className: "text-xs text-muted-foreground", children: ["Target path:", ' ', _jsx("code", { className: "rounded bg-muted px-1 py-0.5 text-[11px]", children: status.commandPath })] })) : null, _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => setDialogOpen(false), disabled: busyAction !== null, children: "Cancel" }), _jsx(Button, { onClick: () => void (isEnabled ? handleRemove() : handleInstall()), disabled: busyAction !== null || !isSupported, children: busyAction === 'remove'
                                        ? 'Removing…'
                                        : busyAction === 'install'
                                            ? 'Registering…'
                                            : isEnabled
                                                ? 'Remove'
                                                : 'Register' })] })] }) })] }));
}
