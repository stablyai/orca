import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
const SSH_PREFIX = 'SSH connection is not active';
function isSshError(error) {
    return error.startsWith(SSH_PREFIX);
}
export function TerminalErrorToast({ error, onDismiss }) {
    const ssh = isSshError(error);
    return (_jsx("div", { style: {
            position: 'absolute',
            bottom: 12,
            left: 12,
            right: 12,
            zIndex: 50,
            padding: '10px 14px',
            borderRadius: 6,
            background: ssh ? 'rgba(234, 179, 8, 0.12)' : 'rgba(220, 38, 38, 0.15)',
            border: ssh ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(220, 38, 38, 0.4)',
            color: ssh ? '#fde68a' : '#fca5a5',
            fontSize: 12,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            pointerEvents: 'auto'
        }, children: _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'start' }, children: [_jsxs("span", { children: [error, !ssh && (_jsxs(_Fragment, { children: ['\n', "If this persists, please", ' ', _jsx("a", { href: "https://github.com/stablyai/orca/issues", style: { color: '#fca5a5', textDecoration: 'underline' }, children: "file an issue" }), "."] }))] }), _jsx("button", { onClick: onDismiss, style: {
                        background: 'none',
                        border: 'none',
                        color: ssh ? '#fde68a' : '#fca5a5',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: '0 0 0 8px',
                        lineHeight: 1,
                        flexShrink: 0
                    }, children: "\u00D7" })] }) }));
}
