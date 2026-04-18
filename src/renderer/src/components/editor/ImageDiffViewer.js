import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import ImageViewer from './ImageViewer';
function ImageDiffPane({ label, content, filePath, mimeType }) {
    if (!content) {
        return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-muted/10", children: [_jsx("div", { className: "px-3 py-2 text-xs font-medium text-muted-foreground", children: label }), _jsx("div", { className: "flex flex-1 items-center justify-center bg-muted/20 p-6 text-sm text-muted-foreground", children: "No preview" })] }));
    }
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-muted/10", children: [_jsx("div", { className: "px-3 py-2 text-xs font-medium text-muted-foreground", children: label }), _jsx("div", { className: "min-h-0 flex-1", children: _jsx(ImageViewer, { content: content, filePath: filePath, mimeType: mimeType }) })] }));
}
export default function ImageDiffViewer({ originalContent, modifiedContent, filePath, mimeType, sideBySide }) {
    // Why: in inline (single-column) mode the grid defaults to equal row
    // heights, which squishes each preview into half the panel. Using
    // minmax(32rem, 1fr) ensures content panes are tall enough to show a
    // full page, and overflow-y-auto lets the user scroll between them.
    // Empty "No preview" panes collapse to auto height.
    const gridRowStyle = !sideBySide
        ? {
            gridTemplateRows: `${originalContent ? 'minmax(32rem, 1fr)' : 'auto'} ${modifiedContent ? 'minmax(32rem, 1fr)' : 'auto'}`
        }
        : undefined;
    return (_jsxs("div", { className: `grid h-full min-h-0 gap-3 p-3 ${sideBySide ? 'grid-cols-2' : 'grid-cols-1 overflow-y-auto'}`, style: gridRowStyle, children: [_jsx(ImageDiffPane, { label: "Original", content: originalContent, filePath: filePath, mimeType: mimeType }), _jsx(ImageDiffPane, { label: "Modified", content: modifiedContent, filePath: filePath, mimeType: mimeType })] }));
}
