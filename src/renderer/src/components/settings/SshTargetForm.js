import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { FileKey } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
export const EMPTY_FORM = {
    label: '',
    configHost: '',
    host: '',
    port: '22',
    username: '',
    identityFile: '',
    proxyCommand: '',
    jumpHost: ''
};
export function SshTargetForm({ editingId, form, onFormChange, onSave, onCancel }) {
    return (_jsxs("div", { className: "space-y-4 rounded-lg border border-border/50 bg-card/40 p-4", children: [_jsx("p", { className: "text-sm font-medium", children: editingId ? 'Edit SSH Target' : 'New SSH Target' }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Label" }), _jsx(Input, { value: form.label, onChange: (e) => onFormChange((f) => ({ ...f, label: e.target.value })), placeholder: "My Server" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Host *" }), _jsx(Input, { value: form.host, onChange: (e) => onFormChange((f) => ({ ...f, host: e.target.value })), placeholder: "192.168.1.100 or server.example.com" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Username *" }), _jsx(Input, { value: form.username, onChange: (e) => onFormChange((f) => ({ ...f, username: e.target.value })), placeholder: "deploy" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Port" }), _jsx(Input, { type: "number", value: form.port, onChange: (e) => onFormChange((f) => ({ ...f, port: e.target.value })), placeholder: "22", min: 1, max: 65535 })] }), _jsxs("div", { className: "col-span-2 space-y-1.5", children: [_jsxs(Label, { className: "flex items-center gap-1.5", children: [_jsx(FileKey, { className: "size-3.5" }), "Identity File"] }), _jsx(Input, { value: form.identityFile, onChange: (e) => onFormChange((f) => ({ ...f, identityFile: e.target.value })), placeholder: "~/.ssh/id_ed25519 (leave empty for SSH agent)" }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "Optional. SSH agent is used by default." })] }), _jsxs("div", { className: "col-span-2 space-y-1.5", children: [_jsx(Label, { children: "Proxy Command" }), _jsx(Input, { value: form.proxyCommand, onChange: (e) => onFormChange((f) => ({ ...f, proxyCommand: e.target.value })), placeholder: "e.g. cloudflared access ssh --hostname %h" }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand)." })] }), _jsxs("div", { className: "col-span-2 space-y-1.5", children: [_jsx(Label, { children: "Jump Host" }), _jsx(Input, { value: form.jumpHost, onChange: (e) => onFormChange((f) => ({ ...f, jumpHost: e.target.value })), placeholder: "bastion.example.com" }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "Optional. Equivalent to ProxyJump / ssh -J." })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { size: "sm", onClick: onSave, children: editingId ? 'Save Changes' : 'Add Target' }), _jsx(Button, { variant: "ghost", size: "sm", onClick: onCancel, children: "Cancel" })] })] }));
}
