import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Code, Eye } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
export default function MarkdownViewToggle({ mode, onChange }) {
    return (_jsxs(ToggleGroup, { type: "single", size: "sm", className: "h-6 [&_[data-slot=toggle-group-item]]:h-7 [&_[data-slot=toggle-group-item]]:min-w-5 [&_[data-slot=toggle-group-item]]:px-2.5", variant: "outline", value: mode, onValueChange: (v) => {
            if (v) {
                onChange(v);
            }
        }, children: [_jsx(ToggleGroupItem, { value: "source", "aria-label": "Source", title: "Source", children: _jsx(Code, { className: "h-2 w-2" }) }), _jsx(ToggleGroupItem, { value: "rich", "aria-label": "Rich", title: "Rich", children: _jsx(Eye, { className: "h-2 w-2" }) })] }));
}
