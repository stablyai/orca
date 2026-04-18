import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { cn } from '@/lib/utils';
const StatusIndicator = React.memo(function StatusIndicator({ status, className, ...props }) {
    if (status === 'working') {
        return (_jsx("span", { className: cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className), ...props, children: _jsx("span", { className: "block size-2 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" }) }));
    }
    return (_jsx("span", { className: cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className), ...props, children: _jsx("span", { className: cn('block size-2 rounded-full', status === 'active'
                ? 'bg-emerald-500'
                : status === 'permission'
                    ? 'bg-red-500'
                    : 'bg-neutral-500/40') }) }));
});
export default StatusIndicator;
