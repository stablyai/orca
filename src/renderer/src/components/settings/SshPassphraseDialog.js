import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAppStore } from '@/store';
export function SshPassphraseDialog() {
    const request = useAppStore((s) => s.sshCredentialQueue[0] ?? null);
    const targetLabels = useAppStore((s) => s.sshTargetLabels);
    const removeRequest = useAppStore((s) => s.removeSshCredentialRequest);
    const [value, setValue] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const inputRef = useRef(null);
    const open = request !== null;
    const requestId = request?.requestId;
    // Why: reset form state during render (not useEffect) so the cleared input is
    // visible on the same paint as the new request arriving — useEffect would
    // leave one render showing the previous passphrase value.
    const [prevRequestId, setPrevRequestId] = useState(requestId);
    if (requestId !== prevRequestId) {
        setPrevRequestId(requestId);
        if (requestId) {
            setValue('');
            setSubmitting(false);
        }
    }
    // DOM focus is a side effect that must remain in useEffect.
    useEffect(() => {
        if (requestId) {
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, [requestId]);
    const handleSubmit = useCallback(async () => {
        if (!request || !value) {
            return;
        }
        setSubmitting(true);
        try {
            await window.api.ssh.submitCredential({ requestId: request.requestId, value });
            removeRequest(request.requestId);
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to submit SSH credential');
            setSubmitting(false);
        }
    }, [request, value, removeRequest]);
    const handleCancel = useCallback(async () => {
        if (request) {
            setSubmitting(true);
            try {
                await window.api.ssh.submitCredential({ requestId: request.requestId, value: null });
                removeRequest(request.requestId);
            }
            catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to cancel SSH credential request');
                setSubmitting(false);
            }
        }
    }, [request, removeRequest]);
    if (!request) {
        return null;
    }
    const label = targetLabels.get(request.targetId) ?? request.targetId;
    const isPassword = request.kind === 'password';
    return (_jsx(Dialog, { open: open, onOpenChange: (isOpen) => !isOpen && void handleCancel(), children: _jsxs(DialogContent, { showCloseButton: false, className: "max-w-[360px]", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: isPassword ? 'SSH Password' : 'SSH Key Passphrase' }), _jsx(DialogDescription, { className: "text-xs", children: isPassword ? (_jsxs(_Fragment, { children: ["Enter the password for ", _jsx("span", { className: "font-medium", children: label })] })) : (_jsxs(_Fragment, { children: ["Enter the passphrase for ", _jsx("span", { className: "font-medium", children: label })] })) })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "ssh-credential-input", className: "text-[11px] font-medium text-muted-foreground mb-1 block", children: isPassword ? `Password for ${request.detail}` : `Passphrase for ${request.detail}` }), _jsx(Input, { id: "ssh-credential-input", ref: inputRef, type: "password", value: value, onChange: (e) => setValue(e.target.value), onKeyDown: (e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleSubmit();
                                }
                            }, placeholder: isPassword ? 'Enter password' : 'Enter passphrase', className: "h-8 text-sm", disabled: submitting })] }), _jsxs(DialogFooter, { className: "mt-1", children: [_jsx(Button, { variant: "outline", size: "sm", onClick: () => void handleCancel(), disabled: submitting, children: "Cancel" }), _jsx(Button, { size: "sm", onClick: () => void handleSubmit(), disabled: !value || submitting, children: isPassword ? 'Connect' : 'Unlock' })] })] }) }));
}
