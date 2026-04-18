import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { useAppStore } from '@/store';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
const GroupControls = React.memo(function GroupControls() {
    const groupBy = useAppStore((s) => s.groupBy);
    const setGroupBy = useAppStore((s) => s.setGroupBy);
    return (_jsx("div", { className: "flex items-center justify-between px-2 pb-1.5 gap-1", children: _jsxs(ToggleGroup, { type: "single", value: groupBy, onValueChange: (v) => {
                if (v) {
                    setGroupBy(v);
                }
            }, variant: "outline", size: "sm", className: "h-6 flex-1 justify-start", children: [_jsx(ToggleGroupItem, { value: "none", className: "h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground", children: "All" }), _jsx(ToggleGroupItem, { value: "pr-status", className: "h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground", children: "PR Status" }), _jsx(ToggleGroupItem, { value: "repo", className: "h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground", children: "Repo" })] }) }));
});
export default GroupControls;
