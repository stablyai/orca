import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useAppStore } from '../../store';
import { matchesSettingsSearch } from './settings-search';
export function SettingsSection({ id, title, description, searchEntries, children, className, badge }) {
    const query = useAppStore((state) => state.settingsSearchQuery);
    if (!matchesSettingsSearch(query, searchEntries)) {
        return null;
    }
    return (_jsxs("section", { id: id, "data-settings-section": id, className: 
        // Why: these sections already contain many internal borders and cards, so a lone divider
        // line gets lost in the visual noise. Giving each section its own padded surface creates a
        // clear outer silhouette that still works when the inner content changes.
        className ??
            'scroll-mt-6 space-y-8 rounded-2xl border border-border/60 bg-card/35 px-6 py-6 shadow-sm', children: [_jsxs("div", { className: "space-y-1", children: [_jsxs("h2", { className: "flex items-center gap-2 text-xl font-semibold", children: [title, badge ? (_jsx("span", { className: "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground", children: badge })) : null] }), _jsx("p", { className: "text-sm text-muted-foreground", children: description })] }), children] }));
}
