import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { BellRing, Bot, Siren } from 'lucide-react';
export const NOTIFICATIONS_PANE_SEARCH_ENTRIES = [
    {
        title: 'Enable Notifications',
        description: 'Master switch for Orca desktop notifications.',
        keywords: ['notifications', 'desktop', 'system', 'native']
    },
    {
        title: 'Agent Task Complete',
        description: 'Notify when a coding agent transitions from working to idle.',
        keywords: ['notifications', 'agent', 'complete', 'idle', 'task']
    },
    {
        title: 'Terminal Bell',
        description: 'Notify when a background terminal emits a bell character.',
        keywords: ['notifications', 'terminal', 'bell', 'attention']
    },
    {
        title: 'Suppress While Focused',
        description: 'Avoid notifying when Orca is focused on the active worktree.',
        keywords: ['notifications', 'focused', 'suppress', 'filtering']
    },
    {
        title: 'Send Test Notification',
        description: 'Trigger a sample desktop notification using the native delivery path.',
        keywords: ['notifications', 'test']
    }
];
export function NotificationsPane({ settings, updateSettings }) {
    const notificationSettings = settings.notifications;
    const updateNotificationSettings = (updates) => {
        updateSettings({
            notifications: {
                ...notificationSettings,
                ...updates
            }
        });
    };
    const handleSendTestNotification = async () => {
        const result = await window.api.notifications.dispatch({ source: 'test' });
        if (result.delivered) {
            toast.success('Test notification sent');
        }
    };
    return (_jsxs("div", { className: "space-y-1", children: [_jsx(SettingToggle, { label: "Enable Notifications", description: "Native system notifications for background events.", checked: notificationSettings.enabled, onToggle: () => updateNotificationSettings({ enabled: !notificationSettings.enabled }) }), _jsx(Separator, {}), _jsx(SettingToggle, { icon: _jsx(Bot, { className: "size-4" }), label: "Agent Task Complete", description: "A coding agent finishes and becomes idle.", checked: notificationSettings.agentTaskComplete, disabled: !notificationSettings.enabled, onToggle: () => updateNotificationSettings({
                    agentTaskComplete: !notificationSettings.agentTaskComplete
                }) }), _jsx(SettingToggle, { icon: _jsx(Siren, { className: "size-4" }), label: "Terminal Bell", description: "A background terminal emits a bell character.", checked: notificationSettings.terminalBell, disabled: !notificationSettings.enabled, onToggle: () => updateNotificationSettings({
                    terminalBell: !notificationSettings.terminalBell
                }) }), _jsx(Separator, {}), _jsx(SettingToggle, { label: "Suppress While Focused", description: "Skip notifications when the triggering worktree is already visible.", checked: notificationSettings.suppressWhenFocused, disabled: !notificationSettings.enabled, onToggle: () => updateNotificationSettings({
                    suppressWhenFocused: !notificationSettings.suppressWhenFocused
                }) }), _jsx("div", { className: "px-1 pt-3", children: _jsxs(Button, { variant: "outline", size: "sm", disabled: !notificationSettings.enabled, onClick: () => void handleSendTestNotification(), className: "gap-2", children: [_jsx(BellRing, { className: "size-3.5" }), "Send Test Notification"] }) })] }));
}
function SettingToggle({ label, description, checked, onToggle, disabled = false, icon }) {
    return (_jsxs("div", { className: "flex items-center justify-between gap-4 px-1 py-2", children: [_jsxs("div", { className: "space-y-0.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [icon, _jsx(Label, { children: label })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: description })] }), _jsx("button", { role: "switch", "aria-checked": checked, "aria-label": label, disabled: disabled, onClick: onToggle, className: `relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${checked ? 'bg-foreground' : 'bg-muted-foreground/30'} ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`, children: _jsx("span", { className: `pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}` }) })] }));
}
