import { jsx as _jsx } from "react/jsx-runtime";
import { useAppStore } from '../../store';
import { matchesSettingsSearch } from './settings-search';
export function SearchableSetting({ title, description, keywords, children, className }) {
    const query = useAppStore((state) => state.settingsSearchQuery);
    if (!matchesSettingsSearch(query, { title, description, keywords })) {
        return null;
    }
    return _jsx("div", { className: className, children: children });
}
