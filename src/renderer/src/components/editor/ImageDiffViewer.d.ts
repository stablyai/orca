import { type JSX } from 'react';
type ImageDiffViewerProps = {
    originalContent: string;
    modifiedContent: string;
    filePath: string;
    mimeType?: string;
    sideBySide: boolean;
};
export default function ImageDiffViewer({ originalContent, modifiedContent, filePath, mimeType, sideBySide }: ImageDiffViewerProps): JSX.Element;
export {};
