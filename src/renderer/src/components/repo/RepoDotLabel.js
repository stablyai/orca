import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '@/lib/utils';
function RepoDotLabel({ name, color, className, dotClassName }) {
    return (_jsxs("span", { className: cn('inline-flex min-w-0 items-center gap-1.5', className), children: [_jsx("span", { className: cn('size-1.5 shrink-0 rounded-full', dotClassName), style: { backgroundColor: color } }), _jsx("span", { className: "truncate", children: name })] }));
}
export default RepoDotLabel;
