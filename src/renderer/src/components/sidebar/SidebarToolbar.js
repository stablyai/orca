import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from 'react';
import { ExternalLink, FolderPlus, Github, MessageSquareText, Settings } from 'lucide-react';
import { useAppStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
const GITHUB_ISSUES_URL = 'https://github.com/stablyai/orca/issues/';
const DISCORD_URL = 'https://discord.gg/fzjDKHxv8Q';
const X_URL = 'https://x.com/orca_build';
const FEEDBACK_API_URL = 'https://api.onorca.dev/v1/feedback';
const FEEDBACK_API_FALLBACK_URL = 'https://www.onorca.dev/v1/feedback';
function openExternalUrl(url) {
    void window.api.shell.openUrl(url);
}
function getSubmitIdentity(viewer, anonymous) {
    if (anonymous || !viewer) {
        return {
            githubLogin: null,
            githubEmail: null
        };
    }
    return {
        githubLogin: viewer.login,
        githubEmail: viewer.email
    };
}
async function submitFeedback(body) {
    try {
        return await fetch(FEEDBACK_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Why: DNS for the dedicated api.onorca.dev host can lag behind a deploy.
        // Falling back to the verified website-hosted versioned endpoint keeps
        // feedback submission working instead of forcing users to wait on DNS.
        if (message.includes('ERR_NAME_NOT_RESOLVED') ||
            message.includes('ENOTFOUND') ||
            message.includes('Failed to fetch')) {
            return fetch(FEEDBACK_API_FALLBACK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }
        throw error;
    }
}
function FeedbackDialog({ open, onOpenChange }) {
    const [feedback, setFeedback] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [viewer, setViewer] = useState(null);
    const [isViewerLoading, setIsViewerLoading] = useState(false);
    const [submitAnonymously, setSubmitAnonymously] = useState(false);
    React.useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        setIsViewerLoading(true);
        void window.api.gh
            .viewer()
            .then((nextViewer) => {
            if (!cancelled) {
                setViewer(nextViewer);
            }
        })
            .catch((err) => {
            if (!cancelled) {
                setViewer(null);
                console.error('Failed to load GitHub viewer:', err);
            }
        })
            .finally(() => {
            if (!cancelled) {
                setIsViewerLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open]);
    const handleSubmit = async () => {
        const trimmed = feedback.trim();
        if (!trimmed) {
            toast.warning('Please enter feedback before submitting.');
            return;
        }
        setIsSubmitting(true);
        try {
            const identity = getSubmitIdentity(viewer, submitAnonymously);
            const response = await submitFeedback({
                // Why: showing the exact GitHub identity in the dialog makes the
                // default attribution explicit, and this flag lets users opt out
                // without having to disconnect gh for the rest of Orca.
                feedback: trimmed,
                githubLogin: identity.githubLogin,
                githubEmail: identity.githubEmail
            });
            if (!response.ok) {
                throw new Error(`Feedback request failed with status ${response.status}`);
            }
            toast.success('Thanks for the feedback.');
            setFeedback('');
            setSubmitAnonymously(false);
            onOpenChange(false);
        }
        catch (err) {
            toast.error('Failed to submit feedback. Please try again.');
            console.error('Failed to submit feedback:', err);
        }
        finally {
            setIsSubmitting(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Send Feedback" }), _jsx(DialogDescription, { className: "text-xs", children: "Share what's working, what's broken, or what Orca should do next." })] }), _jsxs("div", { className: "space-y-2 rounded-md border border-border/70 bg-muted/30 p-3", children: [_jsx("div", { className: "text-xs font-medium text-foreground", children: "Other ways to reach us" }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs(Button, { type: "button", variant: "outline", size: "sm", className: "h-8 text-xs", onClick: () => openExternalUrl(GITHUB_ISSUES_URL), children: [_jsx(Github, { className: "size-3.5" }), "GitHub issues", _jsx(ExternalLink, { className: "size-3.5" })] }), _jsxs(Button, { type: "button", variant: "outline", size: "sm", className: "h-8 text-xs", onClick: () => openExternalUrl(DISCORD_URL), children: [_jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", className: "size-3.5 fill-current", children: _jsx("path", { d: "M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.191.328-.403.77-.553 1.116a18.27 18.27 0 0 0-5.098 0A12.64 12.64 0 0 0 9.68 3a19.736 19.736 0 0 0-4.433 1.369C2.444 8.479 1.69 12.488 2.067 16.44a19.912 19.912 0 0 0 5.427 2.744c.438-.598.828-1.23 1.164-1.89a12.95 12.95 0 0 1-1.833-.877c.154-.113.305-.231.45-.352a14.294 14.294 0 0 0 12.45 0c.146.12.296.239.45.352-.585.34-1.2.634-1.835.878.337.659.727 1.29 1.165 1.888a19.84 19.84 0 0 0 5.43-2.744c.442-4.579-.755-8.551-3.932-12.07ZM9.955 14.005c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.955 2.419-2.157 2.419Zm4.09 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.946 2.419-2.157 2.419Z" }) }), "Join Discord", _jsx(ExternalLink, { className: "size-3.5" })] }), _jsxs(Button, { type: "button", variant: "outline", size: "sm", className: "h-8 text-xs", onClick: () => openExternalUrl(X_URL), children: [_jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", className: "size-3.5 fill-current", children: _jsx("path", { d: "M18.901 1.153h3.68l-8.041 9.19L24 22.847h-7.406l-5.8-7.584-6.64 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932 6.064-6.932Zm-1.29 19.493h2.04L6.486 3.24H4.298l13.313 17.406Z" }) }), "Follow on X", _jsx(ExternalLink, { className: "size-3.5" })] })] })] }), _jsx("textarea", { autoFocus: true, value: feedback, onChange: (event) => setFeedback(event.target.value), placeholder: "What could we improve?", rows: 7, className: "min-h-32 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" }), _jsx("div", { className: "min-h-9 rounded-md border border-border/70 bg-muted/30 px-3 py-2", children: viewer ? (_jsxs("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", children: [_jsxs("span", { children: ["GitHub:", ' ', _jsxs("span", { className: "font-mono text-foreground", children: [viewer.login, viewer.email ? ` (${viewer.email})` : ''] })] }), _jsxs("label", { className: "flex cursor-pointer items-center gap-2 text-foreground", children: [_jsx("input", { type: "checkbox", checked: submitAnonymously, onChange: (event) => setSubmitAnonymously(event.target.checked), className: cn('size-3.5 rounded border border-border bg-background align-middle', 'accent-foreground') }), "Submit anonymously"] })] })) : isViewerLoading ? (_jsx("div", { className: "text-xs text-muted-foreground", children: "Checking GitHub identity\u2026" })) : (_jsx("div", { className: "text-xs text-muted-foreground", children: "Submit with your typed feedback only, or connect `gh` to include GitHub identity." })) }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), disabled: isSubmitting, children: "Cancel" }), _jsx(Button, { onClick: () => void handleSubmit(), disabled: isSubmitting || !feedback.trim(), children: isSubmitting ? 'Sending…' : 'Send' })] })] }) }));
}
const SidebarToolbar = React.memo(function SidebarToolbar() {
    const openModal = useAppStore((s) => s.openModal);
    const openSettingsPage = useAppStore((s) => s.openSettingsPage);
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    return (_jsxs("div", { className: "mt-auto shrink-0", children: [_jsxs("div", { className: "flex items-center justify-between border-t border-sidebar-border px-2 py-1.5", children: [_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsxs(Button, { variant: "ghost", size: "xs", onClick: () => openModal('add-repo'), className: "gap-1.5 text-muted-foreground", children: [_jsx(FolderPlus, { className: "size-3.5" }), _jsx("span", { className: "text-[11px]", children: "Add Repo" })] }) }), _jsx(TooltipContent, { side: "top", sideOffset: 4, children: "Open folder picker to add a repo" })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", onClick: () => setFeedbackOpen(true), className: "text-muted-foreground", children: _jsx(MessageSquareText, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "top", sideOffset: 4, children: "Send feedback" })] }), _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-xs", onClick: openSettingsPage, className: "text-muted-foreground", children: _jsx(Settings, { className: "size-3.5" }) }) }), _jsx(TooltipContent, { side: "top", sideOffset: 4, children: "Settings" })] })] })] }), _jsx(FeedbackDialog, { open: feedbackOpen, onOpenChange: setFeedbackOpen })] }));
});
export default SidebarToolbar;
