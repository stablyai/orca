import React from 'react';
type MermaidBlockProps = {
    content: string;
    isDark: boolean;
    htmlLabels?: boolean;
};
/**
 * Renders a mermaid diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function MermaidBlock({ content, isDark, htmlLabels }: MermaidBlockProps): React.JSX.Element;
export {};
