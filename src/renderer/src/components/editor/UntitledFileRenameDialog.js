import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
export function UntitledFileRenameDialog({ open, currentName, worktreePath, externalError, onClose, onConfirm }) {
    const baseName = currentName.replace(/\.md$/, '');
    const [name, setName] = useState(baseName);
    const [dir, setDir] = useState(worktreePath);
    const [error, setError] = useState(null);
    const nameInputRef = useRef(null);
    const displayError = externalError ?? error;
    useEffect(() => {
        if (open) {
            setName(baseName);
            setDir(worktreePath);
            setError(null);
            requestAnimationFrame(() => {
                nameInputRef.current?.select();
            });
        }
    }, [open, baseName, worktreePath]);
    const handleBrowse = useCallback(async () => {
        const picked = await window.api.shell.pickDirectory({ defaultPath: dir || worktreePath });
        if (!picked) {
            return;
        }
        setDir(picked);
        setError(null);
    }, [dir, worktreePath]);
    const handleSubmit = useCallback(() => {
        const trimmedName = name.trim().replace(/\.md$/, '');
        if (!trimmedName) {
            setError('Name cannot be empty');
            return;
        }
        if (/[/\\]/.test(trimmedName)) {
            setError('Name cannot contain path separators');
            return;
        }
        const trimmedDir = dir.trim().replace(/\/+$/, '');
        if (!trimmedDir) {
            setError('Folder path cannot be empty');
            return;
        }
        // Why: strict prefix check with trailing '/' prevents partial directory
        // name matches (e.g. "/project-backup" matching "/project").
        if (trimmedDir !== worktreePath && !trimmedDir.startsWith(`${worktreePath}/`)) {
            setError('Folder must be inside the current workspace');
            return;
        }
        const fileName = `${trimmedName}.md`;
        const relDir = trimmedDir.slice(worktreePath.length).replace(/^\/+/, '');
        const relativePath = relDir ? `${relDir}/${fileName}` : fileName;
        onConfirm(relativePath);
    }, [name, dir, worktreePath, onConfirm]);
    return (_jsx(Dialog, { open: open, onOpenChange: (isOpen) => !isOpen && onClose(), children: _jsxs(DialogContent, { showCloseButton: false, className: "max-w-[340px]", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Save as" }), _jsx(DialogDescription, { className: "text-xs", children: "Name your markdown file and pick a folder." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground mb-1 block", children: "Name" }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Input, { ref: nameInputRef, value: name, onChange: (e) => {
                                                setName(e.target.value);
                                                setError(null);
                                            }, onKeyDown: (e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleSubmit();
                                                }
                                            }, placeholder: "file name", className: "h-8 text-sm", "aria-invalid": !!displayError }), _jsx("span", { className: "text-xs text-muted-foreground shrink-0", children: ".md" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-[11px] font-medium text-muted-foreground mb-1 block", children: "Folder" }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Input, { value: dir, onChange: (e) => {
                                                setDir(e.target.value);
                                                setError(null);
                                            }, onKeyDown: (e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleSubmit();
                                                }
                                            }, className: "h-8 text-xs" }), _jsx(Button, { type: "button", variant: "outline", size: "icon", className: "h-8 w-8 shrink-0", onClick: () => void handleBrowse(), title: "Browse folders", children: _jsx(FolderOpen, { className: "size-3.5" }) })] })] })] }), displayError && _jsx("p", { className: "text-xs text-destructive mt-1", children: displayError }), _jsxs(DialogFooter, { className: "mt-1", children: [_jsx(Button, { variant: "outline", size: "sm", onClick: onClose, children: "Cancel" }), _jsx(Button, { size: "sm", onClick: handleSubmit, children: "Save" })] })] }) }));
}
