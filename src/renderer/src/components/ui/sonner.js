import { jsx as _jsx } from "react/jsx-runtime";
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { Toaster as Sonner } from 'sonner';
import { useAppStore } from '@/store';
const Toaster = ({ ...props }) => {
    const theme = useAppStore((s) => s.settings?.theme) || 'system';
    return (_jsx(Sonner, { theme: theme, position: "bottom-right", className: "toaster group", icons: {
            success: _jsx(CircleCheckIcon, { className: "size-4" }),
            info: _jsx(InfoIcon, { className: "size-4" }),
            warning: _jsx(TriangleAlertIcon, { className: "size-4" }),
            error: _jsx(OctagonXIcon, { className: "size-4" }),
            loading: _jsx(Loader2Icon, { className: "size-4 animate-spin" })
        }, style: {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
            '--border-radius': 'var(--radius)'
        }, ...props }));
};
export { Toaster };
